import { expect, it } from "vitest"
import { Effect, Fiber } from "effect"
import { ArrayJobBuffer, JobBuffer } from "../../../src/watch/Scheduler.js"
import { CheckResult, ResponseMetadata, Up, targetId } from "../../../src/domain/schema.js"
import { StatusState } from "../../../src/watch/StatusState.js"

const check = (id: string, at: number) => new CheckResult({ id, targetId: targetId("target_state"), checkedAt: new Date(at), duration: 1, classification: new Up(), response: new ResponseMetadata({}) })
it("DP-27", async () => { const state = new StatusState(); await Promise.all([state.update(check("new", 2)), state.update(check("old", 1))]); expect((await state.get(targetId("target_state")))?.latest.id).toBe("new") })
it("DP-28", async () => { const buffer: any = new ArrayJobBuffer<number>(1); await buffer.offer(1); let settled = false; const second = Promise.resolve(buffer.offer(2)).then(() => { settled = true }); await Promise.resolve(); expect(settled).toBe(false); await buffer.take(); await second })
it("DP-30", () => { const buffer = new JobBuffer<number>(1); expect("take" in buffer.enqueue()).toBe(false); expect("shutdown" in buffer.dequeue()).toBe(false) })
it("DP-31", async () => { const buffer = new JobBuffer<string>(2); await buffer.offer("a"); await buffer.offer("b"); buffer.shutdown(); expect([await buffer.take(), await buffer.take(), await buffer.take()]).toEqual(["a", "b", undefined]); expect(await buffer.offer("late")).toBe(false) })
