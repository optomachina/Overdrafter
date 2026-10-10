async(page) => {
  if(!page.url().startsWith('http://127.0.0.1:4188/')) throw new Error('Local exact-commit review required');
  const buttons=page.getByRole('button',{name:'Select this option',exact:true});
  const retired=buttons.nth(0), linked=buttons.nth(1);
  if(!(await retired.isDisabled()) || !(await linked.isEnabled())) throw new Error('Incorrect eligibility states');
  const description=await retired.getAttribute('aria-describedby');
  if(description!=='quote-refresh-option-retired') throw new Error('Missing accessible refresh guidance');
  await retired.evaluate(element=>element.focus());
  if(await retired.evaluate(element=>element===document.activeElement)) throw new Error('Disabled option received focus');
  await retired.dispatchEvent('click');
  await retired.dispatchEvent('keydown',{key:'Enter'});
  await retired.dispatchEvent('keyup',{key:'Enter'});
  await retired.dispatchEvent('keydown',{key:' '});
  await retired.dispatchEvent('keyup',{key:' '});
  if(await page.evaluate(()=>window.qaSelectionCalls.length)!==0) throw new Error('Retired option dispatched selection');
  await page.getByText('Synthetic historical selection note',{exact:true}).waitFor();
  await page.getByRole('textbox',{name:'Optional delivery, commercial, or approval notes for this selection.'}).fill('Synthetic linked legacy selection');
  await linked.focus();
  await linked.press('Enter');
  await page.getByText('Quote option selected.',{exact:true}).waitFor();
  const calls=await page.evaluate(()=>window.qaSelectionCalls);
  if(calls.length!==1 || calls[0].p_option_id!=='option-linked') throw new Error('Linked legacy-null option did not dispatch exactly once');
  await page.getByText('Synthetic source-less option',{exact:true}).waitFor();
  await page.getByRole('paragraph').filter({hasText:/^Synthetic linked legacy selection$/}).waitFor();
  await page.evaluate(receipt=>{window.qaSourceLinkReceipt=receipt;},{result:'PASS',target:'a7772e1f821bafd9d9b089585ca1e5e8f58759ba',retired:'visible; disabled; unfocusable; accessible guidance; zero dispatches',linkedLegacyNull:'enabled; keyboard selection dispatched once',history:'prior note displayed before selection; latest receipt updated; retired option still visible',calls,boundary:'synthetic HTTP responses; no SQL or provider execution'});
}
