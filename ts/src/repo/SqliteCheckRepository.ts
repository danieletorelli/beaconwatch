import { Option } from "effect";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CheckFailure,
  CheckResult,
  Down,
  Incident,
  InvalidResponse,
  ResponseMetadata,
  Slow,
  Target,
  Unknown,
  Up,
  type Classification,
  type TargetId,
} from "../domain/schema.js";
import {
  InMemoryCheckRepository,
  type CheckRepositoryShape,
  type IncidentTransition,
} from "./CheckRepository.js";
import { RepositoryError } from "../domain/errors.js";
const classes = { Up, Slow, Down, InvalidResponse, Unknown };
type Row = Record<string, unknown>;
export const makeTempFilename = () =>
  join(
    tmpdir(),
    `beaconwatch-${process.pid}-${Date.now()}-${randomUUID()}.sqlite`,
  );
export class SqliteCheckRepository implements CheckRepositoryShape {
  readonly db: DatabaseSync;
  private memory = new InMemoryCheckRepository();
  constructor(
    filename = ":memory:",
    private readonly send: (eventId: number) => void | Promise<void> = () => {},
  ) {
    this.db = new DatabaseSync(filename);
    this.migrate();
  }
  migrate() {
    this.db.exec(
      "create table if not exists targets(id text primary key,json text not null);create table if not exists checks(id text primary key,json text not null);create table if not exists incidents(id text primary key,json text not null);create table if not exists incident_events(id integer primary key autoincrement,incident_id text not null,check_id text not null,event_type text not null,created_at integer not null);create table if not exists delivery_outbox(id integer primary key autoincrement,event_id integer not null unique references incident_events(id),delivered_at integer)",
    );
  }
  private target(s: string) {
    const x = JSON.parse(s) as ConstructorParameters<typeof Target>[0];
    return new Target(x);
  }
  private check(s: string) {
    const x = JSON.parse(s) as any;
    return new CheckResult({
      ...x,
      checkedAt: new Date(x.checkedAt),
      classification: new classes[
        x.classification._tag as keyof typeof classes
      ](),
      failure: x.failure && new CheckFailure(x.failure),
      response: new ResponseMetadata(x.response),
    });
  }
  private incident(s: string) {
    const x = JSON.parse(s) as any;
    return new Incident({
      ...x,
      openedAt: new Date(x.openedAt),
      ...(x.closedAt ? { closedAt: new Date(x.closedAt) } : {}),
    });
  }
  async saveTarget(t: Target) {
    this.db
      .prepare(
        "insert into targets values(?,?) on conflict(id) do update set json=excluded.json",
      )
      .run(t.id, JSON.stringify(t));
  }
  async listTargets() {
    return (
      this.db.prepare("select json from targets order by id").all() as Row[]
    ).map((r) => this.target(String(r.json)));
  }
  async saveCheck(c: CheckResult) {
    const row = this.db
      .prepare("select json from checks where id=?")
      .get(c.id) as Row | undefined;
    if (row) {
      const old = this.check(String(row.json));
      if (JSON.stringify(old) !== JSON.stringify(c))
        throw new RepositoryError({
          operation: "saveCheck",
          cause: "conflicting check id",
        });
      return;
    }
    this.db
      .prepare("insert into checks values(?,?)")
      .run(c.id, JSON.stringify(c));
  }
  async listChecks(id?: TargetId) {
    const rows = (
      id
        ? this.db
            .prepare(
              "select json from checks where json_extract(json,'$.targetId')=? order by json_extract(json,'$.checkedAt'),id",
            )
            .all(id)
        : this.db
            .prepare(
              "select json from checks order by json_extract(json,'$.checkedAt'),id",
            )
            .all()
    ) as Row[];
    return rows.map((r) => this.check(String(r.json)));
  }
  async getIncident(id: string): Promise<Option.Option<Incident>> {
    const r = this.db
      .prepare("select json from incidents where id=?")
      .get(id) as Row | undefined;
    return r ? Option.some(this.incident(String(r.json))) : Option.none();
  }
  async getOpenIncident(id: TargetId): Promise<Option.Option<Incident>> {
    const r = this.db
      .prepare(
        "select json from incidents where json_extract(json,'$.targetId')=? and json_extract(json,'$.status')='Open' order by json_extract(json,'$.openedAt') desc,id desc limit 1",
      )
      .get(id) as Row | undefined;
    return r ? Option.some(this.incident(String(r.json))) : Option.none();
  }
  async saveIncident(i: Incident) {
    this.db
      .prepare(
        "insert into incidents values(?,?) on conflict(id) do update set json=excluded.json",
      )
      .run(i.id, JSON.stringify(i));
  }
  async applyCheck(c: CheckResult): Promise<IncidentTransition> {
    const targets = await this.listTargets();
    const checks = await this.listChecks();
    for (const t of targets) await this.memory.saveTarget(t);
    for (const x of checks) await this.memory.saveCheck(x);
    for (const r of this.db
      .prepare("select json from incidents")
      .all() as Row[])
      await this.memory.saveIncident(this.incident(String(r.json)));
    const transition = await this.memory.applyCheck(c);
    const pendingEvents: number[] = [];
    this.db.exec("begin");
    try {
      await this.saveCheck(c);
      const openResult = await this.memory.getOpenIncident(c.targetId);
      if (Option.isSome(openResult)) await this.saveIncident(openResult.value);
      if (transition === "Closed") {
        for (const row of this.db
          .prepare("select json from incidents")
          .all() as Row[]) {
          const i = this.incident(String(row.json));
          const updatedResult = await this.memory.getIncident(i.id);
          if (Option.isSome(updatedResult)) await this.saveIncident(updatedResult.value);
        }
      }
      if (transition !== "Unchanged") {
        const incidents = this.db.prepare("select id from incidents where json_extract(json,'$.latestCheckId')=? order by id").all(c.id) as Row[];
        for (const incident of incidents) {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const event = this.db.prepare("insert into incident_events(incident_id,check_id,event_type,created_at) values(?,?,?,?) returning id")
                .get(String(incident.id), c.id, transition, Date.now()) as { id: number };
              this.db.prepare("insert into delivery_outbox(event_id) values(?)").run(event.id);
              pendingEvents.push(event.id);
              break;
            } catch (error) {
              if (attempt === 1) throw error;
            }
          }
        }
      }
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
    for (const eventId of pendingEvents) {
      await this.send(eventId);
    }
    return transition;
  }
  async deliverPending(send: (eventId: number) => void | Promise<void>) {
    const rows = this.db.prepare("select id,event_id from delivery_outbox where delivered_at is null order by id").all() as Array<{ id: number; event_id: number }>;
    for (const row of rows) {
      await send(row.event_id);
      this.db.prepare("update delivery_outbox set delivered_at=? where id=? and delivered_at is null").run(Date.now(), row.id);
    }
  }
  close() {
    this.db.close();
  }
}
export const migrate = (r: SqliteCheckRepository) => r.migrate();
export const layerForFile = (f: string) => new SqliteCheckRepository(f);
export const tempLayer = () => layerForFile(makeTempFilename());
