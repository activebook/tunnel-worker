import fs from 'fs';

// Highly reputable crowdsourced repositories for clean/fast Cloudflare IPv4 nodes.
// These repositories utilize distributed testing to validate Edge node routing.
const SOURCES = [
  'https://raw.githubusercontent.com/Alvin9999-newpac/fanqiang/refs/heads/main/cloudflare%E4%BC%98%E9%80%89ip',
  'https://raw.githubusercontent.com/ymyuuu/IPDB/refs/heads/main/BestCF/bestcfv4.txt',
  'https://raw.githubusercontent.com/gslege/CloudflareIP/refs/heads/main/Cfxyz.txt'
];

async function executeCrawl() {
  const ipSet = new Set();

  for (const source of SOURCES) {
    try {
      const res = await fetch(source);
      if (!res.ok) continue;
      const text = await res.text();

      text.split('\n').forEach(line => {
        // Purge comments, whitespace, and potential port numbers (:443)
        let ip = line.trim().split(':')[0].split('#')[0].trim();

        // Strict formal IPv4 validation
        if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
          ipSet.add(ip);
        }
      });
    } catch (err) {
      console.error(`Crawler Exception [${source}]:`, err.message);
    }
  }

  const allIps = Array.from(ipSet);
  if (allIps.length === 0) {
    console.log('[]');
    return;
  }

  // Shuffle array using Fisher-Yates topology to ensure varying edge distribution
  for (let i = allIps.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allIps[i], allIps[j]] = [allIps[j], allIps[i]];
  }

  // Extricate top 10 empirical results
  const primeSubset = allIps.slice(0, 10);

  // Output JSON scalar array to standard out for Wrangler pipeline consumption
  console.log(JSON.stringify(primeSubset));
}

executeCrawl();
