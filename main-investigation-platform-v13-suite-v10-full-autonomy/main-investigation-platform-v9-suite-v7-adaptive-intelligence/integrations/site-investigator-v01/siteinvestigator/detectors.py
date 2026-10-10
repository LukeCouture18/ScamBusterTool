import hashlib, re
from urllib.parse import urljoin, urlparse
from bs4 import BeautifulSoup

PAGE_WORDS={"register":["register","signup","sign-up"],"login":["login","sign-in","signin"],"investment":["invest","plan","yield"],"trading":["trade","trading","market"],"deposit":["deposit","fund","recharge"],"withdrawal":["withdraw","cashout"],"wallet":["wallet","address"],"payment":["payment","pay"],"support":["support","help","chat"],"contact":["contact","about"]}
PATTERNS={
 "BTC":r"(?<![A-Za-z0-9])(?:bc1[ac-hj-np-z02-9]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})(?![A-Za-z0-9])",
 "EVM":r"(?<![A-Fa-f0-9])0x[A-Fa-f0-9]{40}(?![A-Fa-f0-9])",
 "TRON":r"(?<![A-Za-z0-9])T[1-9A-HJ-NP-Za-km-z]{33}(?![A-Za-z0-9])",
 "XRP":r"(?<![A-Za-z0-9])r[1-9A-HJ-NP-Za-km-z]{24,34}(?![A-Za-z0-9])",
 "SOLANA":r"(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{32,44}(?![A-Za-z0-9])"}
EMAIL=re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}",re.I)
PHONE=re.compile(r"(?<!\d)(?:\+?\d[\d .()\-]{7,}\d)(?!\d)")

def page_kind(url,text):
    sample=(url+" "+text[:1000]).lower()
    scores={k:sum(w in sample for w in words) for k,words in PAGE_WORDS.items()}
    return max(scores,key=scores.get) if max(scores.values(),default=0)>0 else "other"

def parse_page(base_url,html):
    soup=BeautifulSoup(html,"html.parser")
    for x in soup(["script","style","noscript"]): x.decompose()
    text=" ".join(soup.get_text(" ",strip=True).split())
    links=[]
    for a in soup.select("a[href]"):
        u=urljoin(base_url,a.get("href"))
        if urlparse(u).scheme in ("http","https"): links.append(u.split("#")[0])
    scripts=[urljoin(base_url,s.get("src")) for s in BeautifulSoup(html,"html.parser").select("script[src]")]
    title=(BeautifulSoup(html,"html.parser").title.string.strip() if BeautifulSoup(html,"html.parser").title and BeautifulSoup(html,"html.parser").title.string else "")
    return title,text,list(dict.fromkeys(links)),scripts

def technologies(headers,html,scripts):
    h=html.lower(); out=[]
    checks={"WordPress":"wp-content","React":"react","Vue.js":"vue.","Angular":"ng-version","Next.js":"__next_data__","Cloudflare":"cf-ray","Bootstrap":"bootstrap","jQuery":"jquery"}
    blob=h+" "+" ".join(scripts).lower()+" "+str(headers).lower()
    for name,needle in checks.items():
        if needle in blob: out.append(name)
    if headers.get("server"): out.append("Server: "+headers["server"])
    return sorted(set(out))

def indicators(text,html):
    socials=sorted(set(re.findall(r"https?://(?:t\.me|telegram\.me|wa\.me|twitter\.com|x\.com|facebook\.com|instagram\.com)/[^\s\"'<>]+",html,re.I)))
    analytics=sorted(set(re.findall(r"(?:G-[A-Z0-9]{6,}|UA-\d{4,}-\d+|GTM-[A-Z0-9]+)",html,re.I)))
    return {"emails":sorted(set(EMAIL.findall(text))),"phones":sorted(set(x.strip() for x in PHONE.findall(text))),"socials":socials,"analytics_ids":analytics}

def wallets(text):
    results=[]
    for network,pat in PATTERNS.items():
        for m in re.finditer(pat,text):
            address=m.group(0); around=text[max(0,m.start()-160):m.end()+160]
            if network=="SOLANA" and not re.search(r"sol|wallet|deposit|address|crypto",around,re.I): continue
            token=None; resolved=network; confidence=.78
            if network=="EVM":
                if re.search(r"trc.?20|tron",around,re.I): continue
                if re.search(r"usdt|tether",around,re.I): token="USDT"
                if re.search(r"bep.?20|binance smart|bnb",around,re.I): resolved="BSC"
                elif re.search(r"erc.?20|ethereum|eth",around,re.I): resolved="ETHEREUM"
                else: resolved="EVM"; confidence=.62
            elif network=="TRON": token="USDT" if re.search(r"usdt|trc.?20|tether",around,re.I) else None
            results.append({"address":address,"network":resolved,"token":token,"context":around,"confidence":confidence})
    return results

def fingerprint(html):
    scrub=re.sub(r"https?://[^\s\"']+|\b\d{5,}\b","<VAR>",html.lower())
    tags=" ".join(re.findall(r"<([a-z][a-z0-9]*)",scrub))
    return hashlib.sha256(tags.encode()).hexdigest()

