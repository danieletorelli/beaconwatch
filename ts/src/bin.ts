import { main } from "./main.js";
main()
  .then(console.log)
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
