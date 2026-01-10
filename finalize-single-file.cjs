const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const distDir = path.join(__dirname, 'dist');
const htmlPath = path.join(distDir, 'index.html');

async function run() {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const dom = new JSDOM(html);
  const document = dom.window.document;

  // Find the main script tag
  const scripts = Array.from(document.querySelectorAll('script'));
  
  for (const script of scripts) {
    const src = script.getAttribute('src');
    
    // Look for the main bundle (starts with ./assets/index- or assets/index-)
    if (src && src.includes('assets/index-')) {
      // Normalize path (handle both ./assets and assets)
      const relativePath = src.startsWith('./') ? src.slice(2) : src;
      const scriptPath = path.join(distDir, relativePath);
      
      if (fs.existsSync(scriptPath)) {
        console.log(`Inlining script: ${scriptPath}`);
        const scriptContent = fs.readFileSync(scriptPath, 'utf8');
        
        // Create new script tag without type="module"
        const newScript = document.createElement('script');
        newScript.textContent = scriptContent.replace(/<\/script>/g, '<\\/script>');
        
        // Replace the old script tag
        script.parentNode.replaceChild(newScript, script);
      } else {
        console.warn(`Script file not found: ${scriptPath}`);
      }
    }
  }

  // Save the result
  fs.writeFileSync(htmlPath, dom.serialize());
  console.log('Successfully finalized dist/index.html using JSDOM.');
}

run().catch(console.error);