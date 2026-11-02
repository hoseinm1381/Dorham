import {readFile} from 'node:fs/promises';
export default async function(){
 if(!process.env.DORHAM_FIXTURE_MANIFEST||!process.env.DORHAM_FIXTURE_NONCE)return;
 const fixture=JSON.parse(await readFile(process.env.DORHAM_FIXTURE_MANIFEST,'utf8'));
 if(fixture.nonce!==process.env.DORHAM_FIXTURE_NONCE)throw Error('Go fixture ownership mismatch');
 const r=await fetch('http://127.0.0.1:3101/__fixture/'+fixture.nonce,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'shutdown'}),signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw Error('Go fixture shutdown failed');
}
