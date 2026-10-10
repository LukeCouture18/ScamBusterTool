import { spawnSync } from "node:child_process";

function run(command,args){const result=spawnSync(command,args,{stdio:"inherit",shell:false,env:process.env});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);}
run(process.execPath,["scripts/run-tests.mjs","unit"]);
run(process.execPath,["scripts/run-framework.mjs","build"]);
