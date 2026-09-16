const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');
(async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    const data=await page.evaluate(()=>{
      const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=630;
      const c=canvas.getContext('2d');c.fillStyle='#ffffff';c.fillRect(0,0,1200,630);
      c.fillStyle='#d01922';c.fillRect(64,70,100,100);c.fillStyle='#ffffff';c.font='bold 44px Arial';c.fillText('AI',88,136);
      c.fillStyle='#111827';c.font='bold 46px "PingFang SC",sans-serif';c.fillText('飞翔的AI资讯站',198,136);
      c.fillStyle='#d01922';c.font='bold 68px "PingFang SC",sans-serif';c.fillText('AI 日报速览',64,298);
      c.fillStyle='#4b5563';c.font='30px "PingFang SC",sans-serif';c.fillText('日报 · 精选 · 动态 · 大事记 · 工具库',64,382);
      c.fillStyle='#d1d5db';c.fillRect(64,452,1072,1);
      c.fillStyle='#4b5563';c.font='26px Arial';c.fillText('yehloo-ai.github.io/ai-news-station',64,520);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    fs.writeFileSync('assets/share-cover.png',Buffer.from(data,'base64'));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
