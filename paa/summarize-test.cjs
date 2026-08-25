// 临时：提取 node --test 结果统计（test-out.txt）
const s = require('fs').readFileSync('test-out.txt', 'utf8');
const m = s.match(/^# (pass|fail|tests|cancelled|skipped) \d+/gm);
console.log(m ? m.join('\n') : '(no summary)');
const lines = s.split('\n');
const fails = [];
for (let i = 0; i < lines.length; i++) {
  if (/^# Subtest: /.test(lines[i]) === false && /^not ok/.test(lines[i])) fails.push(lines[i]);
}
// TAP style failures
const tapFails = lines.filter((l) => /^not ok/.test(l));
if (tapFails.length) console.log('FAILURES:\n' + tapFails.join('\n'));
// spec style: "✖" or failing tests listed under 'failing tests:'
const idx = lines.findIndex((l) => /failing tests:/i.test(l));
if (idx >= 0) console.log(lines.slice(idx, idx + 40).join('\n'));
