import fs from 'node:fs';
const src=fs.readFileSync('worker/src/adapters/providerPortalKernel.ts','utf8');
const m=src.match(/const PROHIBITED_CONFIGURATION_SELECTOR = (\/.*\/i);/);const re=eval(m[1]);
const bad=['checkout','Checkout','CHECKOUT','  checkout  ','\tOrder\n','Place Order','Proceed to Checkout','purchase','PURCHASE now','Payment','add to cart','Cart','reorder','ordering','Shopping-Cart',' payMent '];
const ok=['6061 T6 Aluminum','0.125"','Select material','Steel'];
let f=0;for(const t of bad){const r=re.test(t);console.log('refuse',JSON.stringify(t),r);if(!r)f++}
for(const t of ok){const r=re.test(t);console.log('allow',JSON.stringify(t),!r);if(r)f++}
console.log('CLICK_PROBE_FAILURES',f);
