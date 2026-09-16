const {chromium,webkit,devices}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http=require('node:http'), fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'), output=process.env.TEST_OUTPUT || path.join(root,'test-results');
fs.mkdirSync(output,{recursive:true});
const server=http.createServer((req,res)=>{
  let file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if (!file.startsWith(root + path.sep) && file!==root) {res.writeHead(403).end();return;}
  if (fs.existsSync(file)&&fs.statSync(file).isDirectory()) file=path.join(file,'index.html');
  if (!fs.existsSync(file)) {res.writeHead(404).end();return;}
  const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.xml':'application/xml'}[path.extname(file)]||'text/plain';
  res.writeHead(200,{'Content-Type':type});fs.createReadStream(file).pipe(res);
});
const results=[];
async function checkLayout(page,label) {
  await page.waitForTimeout(120);
  const result=await page.evaluate(()=>({
    width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
    headings:document.querySelectorAll('h1').length,
    brokenImages:[...document.images].filter(e=>e.complete&&!e.naturalWidth&&e.getBoundingClientRect().width).map(e=>e.src),
    cards:document.querySelectorAll('.card,.tl-card,.tool-card').length,
  }));
  assert(result.scrollWidth<=result.width+1,label+': horizontal overflow');
  assert(result.headings>=1,label+': missing main heading');
  await page.screenshot({path:path.join(output,label+'.png')});
  results.push({label,...result});
}
async function run(browserType,name,options,base) {
  const browser=await browserType.launch({headless:true});
  try {
    const context=await browser.newContext({...options,timezoneId:'Asia/Shanghai'});
    await context.addInitScript(()=>localStorage.setItem('ai_station_analytics','off'));
    await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin ? route.continue() : route.abort());
    const page=await context.newPage(),errors=[],requests=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('request',r=>requests.push(r.url()));
    await page.goto(base);await page.locator('.dnp-row').first().waitFor();
    await checkLayout(page,name+'-daily');
    const edition=JSON.parse(fs.readFileSync(path.join(root,'data/daily-latest.json'),'utf8'));
    assert((await page.locator('.dnp-dateline').innerText()).includes(String(Number(edition.date.slice(5,7)))));
    assert.equal(await page.locator('.dnp-row').count(),edition.sections.reduce((n,s)=>n+s.items.length,0));
    for (const id of ['featured','all','timeline','funding','tools']) {
      await page.evaluate(id=>switchTab(id),id);
      await page.waitForFunction(id=>activeTab===id&&!document.querySelector('#main .loading'),id);
      await checkLayout(page,name+'-'+id);
      if (['featured','all'].includes(id)) {
        const expected=JSON.parse(fs.readFileSync(path.join(root,'data/'+id+'.json'))).items;
        assert.equal(await page.locator('#main a.card').count(),expected.length,name+': truncated '+id);
        const translated=expected.filter(item=>item._translated);
        assert(translated.length>0,name+': missing translated data in '+id);
        const visible=await page.locator('#main a.card').allTextContents();
        for(const item of translated){
          assert(/[\u3400-\u9fff]/.test(item.title),name+': translated title is not Chinese');
          assert(visible.some(text=>text.includes(item.title)&&text.includes('机译')),name+': missing Chinese title');
          assert(await page.locator('#main a.card [title]').evaluateAll((els,title)=>els.some(e=>e.title===title),item.titleOriginal),name+': missing original title');
        }
        if(id==='featured'){
          await page.locator('.feat-tl-card').filter({has:page.locator('.translation-label')}).first().scrollIntoViewIfNeeded();
          await page.screenshot({path:path.join(output,name+'-featured-translated.png')});
        }
      }
    }
    await page.locator('#toolSearch').fill('Claude');
    await page.reload();await page.locator('#toolSearch').waitFor();
    assert.equal(await page.locator('#toolSearch').inputValue(),'claude');
    assert((await page.locator('.tool-card:visible').count()) >= 1);
    assert(await page.locator('.tool-card:visible').evaluateAll(els=>els.every(e=>e.dataset.search.includes('claude'))));
    await page.locator('#toolSearch').fill('');
    await page.locator('#toolFreeChip').click();
    const freeBad=await page.locator('.tool-card:visible').evaluateAll(els=>els.filter(e=>e.dataset.free!=='1').length);
    assert.equal(freeBad,0);
    await page.evaluate(()=>switchTab('all'));await page.locator('#allListWrap').waitFor();
    const allText=await page.locator('#allListWrap').innerText();
    await context.route('**/data/all.json',route=>route.abort());
    await page.evaluate(()=>manualRefresh());
    assert.equal(await page.locator('#allListWrap').innerText(),allText,name+': offline refresh lost content');
    await context.unroute('**/data/all.json');
    await page.evaluate(()=>switchTab('daily'));await page.locator('.dnp-row').first().waitFor();
    const archive=JSON.parse(fs.readFileSync(path.join(root,'data/daily-index.json')));
    const slow=archive[1].date,fast=archive[2].date;
    await context.route('**/data/daily/'+slow+'.json',async route=>{await new Promise(r=>setTimeout(r,700));await route.continue();});
    await page.evaluate(([a,b])=>{loadDailyDate(a);loadDailyDate(b);},[slow,fast]);
    await page.waitForTimeout(1000);
    assert.equal(await page.evaluate(()=>archiveActiveDate),fast,name+': stale date response won');
    assert.equal(new URL(page.url()).searchParams.get('date'),fast);
    await page.evaluate(()=>switchTab('featured'));await page.locator('#main .card').first().waitFor();
    await page.goBack();await page.locator('.dnp-row').first().waitFor();
    assert.equal(await page.evaluate(()=>archiveActiveDate),fast);
    if (options.isMobile) {
      await page.evaluate(()=>switchTab('all'));
      await page.locator('#allListWrap').waitFor();
      await page.waitForTimeout(150);
      await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
      await page.waitForFunction(()=>document.getElementById('backToTop').classList.contains('visible'),null,{timeout:5000});
      const scrollInfo=await page.evaluate(()=>({y:scrollY,body:document.body.scrollHeight,doc:document.documentElement.scrollHeight,main:document.querySelector('#main').scrollTop,daily:document.querySelector('#dailyContentCol')?.scrollTop}));
      assert(await page.locator('#backToTop').evaluate(e=>e.classList.contains('visible')),JSON.stringify(scrollInfo));
      const hit=await page.locator('#backToTop').evaluate(e=>{const r=e.getBoundingClientRect();const target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {rect:r.toJSON(),hit:target?.outerHTML.slice(0,400),viewport:{width:innerWidth,height:innerHeight,visualWidth:visualViewport?.width,visualHeight:visualViewport?.height},top:scrollY};});
      results.push({label:name+'-back-to-top-hit',...hit});
      await page.screenshot({path:path.join(output,name+'-bottom.png')});
      await page.locator('#backToTop').click();
      await page.waitForFunction(()=>scrollY===0);
    }
    await page.goto(base+'daily-share/?date='+fast);
    await page.waitForFunction(()=>!document.getElementById('downloadBtn').disabled);
    await checkLayout(page,name+'-share');
    assert((await page.locator('#datePill').innerText()).includes(String(Number(fast.slice(8)))));
    const old=JSON.parse(fs.readFileSync(path.join(root,'data/daily/'+fast+'.json')));
    assert((await page.locator('#timeline').innerText()).includes(old.sections.find(s=>s.items.length).items[0].title));
    const download=page.waitForEvent('download');
    await page.locator('#downloadBtn').click();
    const file=await download;await file.saveAs(path.join(output,name+'-share-export.png'));
    assert(fs.statSync(path.join(output,name+'-share-export.png')).size>10000,'PNG is blank');
    await page.goto(base+'daily-share/?date=2099-01-01');
    await page.waitForFunction(()=>document.getElementById('datePill').textContent==='本期暂不可用');
    assert(await page.locator('#downloadBtn').isDisabled());
    for (const file of ['about/','subscribe/','tools/','timeline/','funding/','admin.html']) {
      await page.goto(base+file);await checkLayout(page,name+'-static-'+file.replace(/[/.]/g,''));
    }
    assert.deepEqual(errors,[],name+': JavaScript errors');
    assert(!requests.some(url=>/translate\.googleapis|allorigins|rss2json/.test(url)),name+': external browser data/translation dependency');
    results.push({label:name+'-interaction-tests',passed:true,requests:requests.length,errors});
    await context.close();
  } finally {await browser.close();}
}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=process.env.TEST_BASE || 'http://127.0.0.1:'+server.address().port+'/';
  try {
    for (const [name,options] of [['desktop',{viewport:{width:1440,height:1000}}],['mobile',{viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:1}],['narrow',{viewport:{width:320,height:740},isMobile:true,deviceScaleFactor:1}]]) await run(chromium,name,options,base);
    if (process.env.TEST_WEBKIT==='1') await run(webkit,'webkit',devices['iPhone 13'],base);
  } finally {server.close();fs.writeFileSync(path.join(output,'browser-report.json'),JSON.stringify(results,null,2));}
  console.log(JSON.stringify(results,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
