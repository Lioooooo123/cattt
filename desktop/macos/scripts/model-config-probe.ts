import { modelConfigProblems, slotNames, slotSpec } from '../../../server/src/config.ts';

const problems = modelConfigProblems();
const slots = slotNames.map(name => {
  const { provider, model } = slotSpec(name);
  return { name, provider, model };
});
console.log(JSON.stringify({ modelConfigProblems: problems, slots }));
if (problems.length) process.exitCode = 1;
