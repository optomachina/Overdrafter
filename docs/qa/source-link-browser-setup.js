// Exact-commit browser fixture for a7772e1; run only against local port 4188.
async(page) => {
  const origin = 'http://127.0.0.1:4188';
  if (!page.url().startsWith(origin + '/')) throw new Error('Local review server required');
  const base = {option_kind:'lowest_cost',requested_quantity:10,published_price_usd:120,lead_time_business_days:5,comparison_summary:'Synthetic published quote details',valid_until:null};
  const options = [
    {...base,id:'option-retired',label:'Synthetic source-less option',source_vendor_quote_offer_id:null},
    {...base,id:'option-linked',label:'Synthetic linked legacy option',source_vendor_quote_offer_id:'offer-linked'},
  ];
  const selections = [{option_id:'option-retired',created_at:'2026-10-01T13:00:00Z',note:'Synthetic historical selection note'}];
  await page.unrouteAll({behavior:'ignoreErrors'});
  await page.route('**/*', async route => {
    const url=route.request().url();
    if(url.startsWith(origin+'/')) return route.continue();
    if(!url.startsWith('http://127.0.0.1:9/')) return route.abort();
    const name=url.split('?')[0].split('/').pop();
    if(name==='api_select_quote_option') {
      const body=route.request().postDataJSON();
      await page.evaluate(value=>window.qaSelectionCalls.push(value),body);
      selections.unshift({option_id:body.p_option_id,created_at:'2026-10-02T05:00:00Z',note:body.p_note});
      return route.fulfill({json:'selection-synthetic'});
    }
    const replies={
      published_quote_packages:{id:'qa-package',job_id:'qa-job',published_at:'2026-10-01T12:00:00Z',client_summary:'Synthetic package eligibility QA'},
      jobs:{id:'qa-job',title:'Synthetic option eligibility',requested_quote_quantities:[10],requested_service_kinds:[]},
      published_quote_options:options,
      client_selections:selections,
      api_get_founding_beta_access_state:{state:'eligible',policyRevision:'synthetic',termsPath:'/terms',privacyPath:'/privacy'},
    };
    if(!(name in replies)) return route.fulfill({status:503,json:{message:'Synthetic boundary: '+name}});
    return route.fulfill({json:replies[name]});
  });
  await page.goto(origin+'/client/packages/qa-package?fixture=client-published&debug=1');
  await page.evaluate(()=>{window.qaSelectionCalls=[];});
  await page.getByText('Synthetic source-less option',{exact:true}).waitFor();
}
