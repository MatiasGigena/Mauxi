export const VISIBLE_BROWSER_SCRIPT = String.raw`function(request, approvedTarget) {
  const state = globalThis.__mauxiVisible || (globalThis.__mauxiVisible = { nodes: new Map(), counter: 0 });
  if (location.href !== request.url) throw new Error('Stale document URL');
  const sensitive = 'input,textarea,select,[contenteditable],script,style,noscript';
  const text = (node) => {
    if (node.matches(sensitive)) return '[redacted]';
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let content = '', visited = 0, child;
    while ((child = walker.nextNode()) && ++visited <= 200 && content.length < 300) {
      if (!child.parentElement?.closest(sensitive)) content += (child.nodeValue || '').slice(0, 300 - content.length) + ' ';
    }
    return content.replace(/\s+/g, ' ').trim().slice(0, 240);
  };
  const fingerprint = (node) => JSON.stringify([node.tagName, node.id, node.getAttribute('data-testid'), node.getAttribute('href'), node.getAttribute('type'), node.getAttribute('role'), node.getAttribute('aria-label'), text(node)]);
  const visible = (node) => { const r = node.getBoundingClientRect(); const s = getComputedStyle(node); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.visibility !== 'hidden' && s.display !== 'none'; };
  if (request.operation === 'inspect') {
    const entries = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let visited = 0, node = walker.currentNode;
    do {
      if (++visited > 2000 || entries.length >= 80) break;
      if (!visible(node) || node.closest('[data-mauxi-overlay],script,style')) continue;
      const id = String(++state.counter);
      state.nodes.set(id, { node, fingerprint: fingerprint(node) });
      const r = node.getBoundingClientRect(), s = getComputedStyle(node);
      entries.push({ target: id, tag: node.tagName.toLowerCase(), text: text(node), testId: (node.getAttribute('data-testid') || '').slice(0, 120),
        sourceHint: (node.getAttribute('data-mauxi-source') || '').slice(0, 512),
        bounds: { x:r.x, y:r.y, width:r.width, height:r.height },
        style: { display:s.display, position:s.position, color:s.color, backgroundColor:s.backgroundColor, font:s.font, padding:s.padding, gap:s.gap, borderRadius:s.borderRadius } });
    } while (node = walker.nextNode());
    while (state.nodes.size > 240) state.nodes.delete(state.nodes.keys().next().value);
    return { text: JSON.stringify({ url:location.href, viewport:{width:innerWidth,height:innerHeight}, entries, bounded:true, source:'DOM hints only; use verified workspace source resolution for provenance' }) };
  }
  if (request.operation === 'scroll') { scrollBy({ left:request.x || 0, top:request.y || 0, behavior:'instant' }); return {text:'Scroll dispatched; inspect/capture the resulting state.'}; }
  const entry = state.nodes.get(request.target);
  if (!entry || !entry.node.isConnected || entry.fingerprint !== fingerprint(entry.node)) throw new Error('Stale DOM target; inspect again');
  const node = entry.node;
  if (request.operation === 'source') return { text:JSON.stringify({tag:node.tagName.toLowerCase(), testId:(node.getAttribute('data-testid') || '').slice(0,512)}) };
  if (!visible(node) || node.closest('iframe,object,embed') || node.getRootNode() !== document) throw new Error('Target is not a visible supported DOM element');
  const r = node.getBoundingClientRect();
  const x = Math.max(0, Math.min(innerWidth-1, r.x + r.width/2)), y = Math.max(0, Math.min(innerHeight-1, r.y + r.height/2));
  const hit = document.elementFromPoint(x,y);
  if (!hit || (hit !== node && !node.contains(hit))) throw new Error('Target is obscured');
  const description = {
    tag: node.tagName.toLowerCase(), text: text(node),
    label: (node.getAttribute('aria-label') || (node.labels?.[0] ? text(node.labels[0]) : '') || node.getAttribute('title') || '').slice(0, 240),
    role: node.getAttribute('role')?.slice(0, 120) || null,
    testId: node.getAttribute('data-testid')?.slice(0, 120) || null,
    type: node instanceof HTMLInputElement || node instanceof HTMLButtonElement ? node.type : null,
    bounds: { x:r.x, y:r.y, width:r.width, height:r.height }
  };
  if (request.operation === 'describe-target') return description;
  const matchesApproval = approvedTarget && ['tag','text','label','role','testId','type'].every(key => description[key] === approvedTarget[key])
    && ['x','y','width','height'].every(key => description.bounds[key] === approvedTarget.bounds?.[key]);
  if (['click','type','hover'].includes(request.operation) && !matchesApproval) throw new Error('Browser target changed after approval; inspect and approve again');
  if (request.operation === 'click') {
    if (!(node instanceof HTMLElement) || node.matches('input[type=file],input[type=password]') || node.closest('a[download]')) throw new Error('Unsupported click target');
    node.click();
    return { text:'Click dispatched to the original visible DOM instance. External effects cannot be undone; inspect the result.' };
  }
  if (request.operation === 'type') {
    if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) || node.disabled || node.readOnly || (node instanceof HTMLInputElement && !['text','search','email','url','tel','number'].includes(node.type))) throw new Error('Only ordinary editable text fields are supported; no passwords/files/hidden fields');
    const setter = Object.getOwnPropertyDescriptor(node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value').set;
    setter.call(node, request.text);
    node.dispatchEvent(new Event('input',{bubbles:true})); node.dispatchEvent(new Event('change',{bubbles:true}));
    return {text:'Text entered in the original visible field; no Enter key or form replay sent.'};
  }
  if (request.operation === 'hover') {
    for (const type of ['pointerover','pointerenter','pointermove']) node.dispatchEvent(new PointerEvent(type, {bubbles:type !== 'pointerenter', clientX:x, clientY:y, pointerType:'mouse'}));
    for (const type of ['mouseover','mouseenter','mousemove']) node.dispatchEvent(new MouseEvent(type, {bubbles:type !== 'mouseenter', clientX:x, clientY:y}));
    return node;
  }
  throw new Error('Unsupported browser operation');
}`;
