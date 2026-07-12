import { parseXlsx } from '/home/user/tekusk/src/lib/xlsx.mjs';
import fs from 'node:fs';
const dir = '/home/user/tekusk/test/fixtures/vegetan/';
function scanYear(file, sheet){
  const wb = parseXlsx(fs.readFileSync(dir+file));
  const g = wb.sheet(sheet ?? wb.sheetNames[0]);
  const hits=[];
  for(let r=0;r<g.length;r++)for(const v of (g[r]||[])){
    if(v!=null && /(令和|平成|年度|\d{4}年|R\d)/.test(String(v))) hits.push(`r${r}:${v}`);
  }
  console.log(file, '::', hits.slice(0,10).join(' | '));
}
scanYear('041-vegetan.alic.go.jp_kouri_cyousa_tomato.xlsx.xlsx');
scanYear('033-vegetan.alic.go.jp_kouri_cyousa_kyabetu.xlsx.xlsx');
scanYear('034-vegetan.alic.go.jp_kouri_cyousa_negi.xlsx.xlsx');
// kouricyousa08 sheets
const wb = parseXlsx(fs.readFileSync(dir+'032-vegetan.alic.go.jp_kouri_cyousa_kouricyousa08.xlsx.xlsx'));
const g = wb.sheet('6月調査結果');
console.log('--- kouricyousa08 6月調査結果 rows=',g.length);
for(let r=0;r<Math.min(g.length,20);r++) console.log(r+':',JSON.stringify((g[r]||[]).slice(0,14).map(v=>v==null?'':String(v).slice(0,9))));
