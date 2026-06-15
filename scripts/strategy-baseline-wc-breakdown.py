"""
Estrae breakdown granulare magazzino Farway via WC REST API.
Categorizza i 121 prodotti per genere/eta/tipo/stagione/prezzo e identifica candidate bundle.
"""
import os, re, sys, json
from collections import defaultdict, Counter
import requests

env = {}
with open("D:/Coding/Farway/farway-photo-app/.env.local", encoding="utf-8-sig") as f:
    for line in f:
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k] = v.strip().strip('"').strip("'")

base = env["WC_STORE_URL"].rstrip("/")
auth = (env["WC_CONSUMER_KEY"], env["WC_CONSUMER_SECRET"])

print("Fetching all products...")
products = []
page = 1
while True:
    r = requests.get(
        f"{base}/wp-json/wc/v3/products",
        auth=auth,
        params={"per_page": 100, "page": page, "status": "publish"},
        timeout=60,
    )
    batch = r.json()
    if not batch:
        break
    products.extend(batch)
    if len(batch) < 100:
        break
    page += 1
print(f"Fetched {len(products)} products")


def age_from_sku(sku):
    if not sku:
        return "unknown"
    m = re.search(r"(\d{2})([MY])", sku)
    if m:
        num, unit = m.group(1), m.group(2)
        if unit == "M":
            return f"{num}M"
        if unit == "Y":
            return f"{num}Y"
    return "unknown"


def season_from_sku(sku):
    if not sku:
        return "unknown"
    m = re.search(r"(PE|FW|MA|SS|AW)(\d{2})", sku)
    if m:
        return f"{m.group(1)}{m.group(2)}"
    return "unknown"


genre_count = defaultdict(int)
type_count = defaultdict(int)
age_count = defaultdict(int)
season_count = defaultdict(int)
price_bucket = defaultdict(int)
stock_count = defaultdict(int)

type_genre = defaultdict(lambda: defaultdict(int))
type_age = defaultdict(lambda: defaultdict(int))
type_price_mean = defaultdict(list)

ceremony_skus = []
newborn_skus = []
abiti_skus = []
accessory_gift_skus = []
summer_skus = []
sale_priced = []

for p in products:
    sku = p.get("sku", "")
    name = p.get("name", "")
    price = float(p.get("price") or p.get("regular_price") or 0)
    sale_price = p.get("sale_price", "")
    if sale_price:
        sale_priced.append((sku, name, price, sale_price))
    stock = p.get("stock_status", "unknown")
    stock_count[stock] += 1
    cat_names = [c.get("name", "") for c in p.get("categories", [])]

    if "Femmina" in cat_names:
        genre_count["Femmina"] += 1
        primary_genre = "F"
    elif "Maschio" in cat_names:
        genre_count["Maschio"] += 1
        primary_genre = "M"
    elif "Unisex" in cat_names:
        genre_count["Unisex"] += 1
        primary_genre = "U"
    else:
        genre_count["?"] += 1
        primary_genre = "?"

    primary_type = None
    for cname in cat_names:
        cname_clean = cname.replace("&amp;", "&")
        if cname_clean == "Abiti":
            primary_type = "Abiti"
            break
        if cname_clean == "Camicie & Bluse":
            primary_type = "Camicie"
            break
        if cname_clean == "Pantaloni":
            primary_type = "Pantaloni"
            break
        if cname_clean == "Gonne":
            primary_type = "Gonne"
            break
        if cname_clean == "Pantaloncini":
            primary_type = "Pantaloncini"
            break
        if cname_clean == "Body & Tutine":
            primary_type = "Body/Tutine"
            break
        if cname_clean == "Felpe & Maglieria":
            primary_type = "Felpe/Maglieria"
            break
        if cname_clean == "T-shirt & Top":
            primary_type = "T-shirt"
            break
        if cname_clean == "Giacche":
            primary_type = "Giacche"
            break
        if cname_clean in ("Capelli", "Cerchietti", "Fiocchi e fermagli", "Scrunchies"):
            primary_type = "Accessori-capelli"
            break
        if cname_clean == "Borse":
            primary_type = "Borse"
            break
    if not primary_type:
        primary_type = "Altro"
    type_count[primary_type] += 1
    type_genre[primary_type][primary_genre] += 1
    type_price_mean[primary_type].append(price)

    age_str = age_from_sku(sku)
    age_count[age_str] += 1
    type_age[primary_type][age_str] += 1

    season = season_from_sku(sku)
    season_count[season] += 1

    if price == 0:
        price_bucket["EUR 0 (mancante)"] += 1
    elif price < 20:
        price_bucket["EUR 0-19"] += 1
    elif price < 40:
        price_bucket["EUR 20-39"] += 1
    elif price < 70:
        price_bucket["EUR 40-69"] += 1
    elif price < 100:
        price_bucket["EUR 70-99"] += 1
    elif price < 150:
        price_bucket["EUR 100-149"] += 1
    else:
        price_bucket["EUR 150+"] += 1

    name_lower = name.lower()
    if primary_type == "Abiti" and any(
        kw in name_lower
        for kw in ["cerimonia", "eleg", "velluto", "cerise", "anjeliy", "charlotte", "masha"]
    ):
        ceremony_skus.append((sku, name, price, age_str))
    if (
        age_str in ("03M", "06M", "09M", "12M")
        or "neonato" in name_lower
        or "tutina" in name_lower
        or primary_type == "Body/Tutine"
    ):
        newborn_skus.append((sku, name, price, age_str))
    if primary_type == "Abiti":
        abiti_skus.append((sku, name, price, age_str, primary_genre))
    if primary_type == "Accessori-capelli" and price < 20:
        accessory_gift_skus.append((sku, name, price))
    if season.startswith("PE") and any(
        kw in name_lower
        for kw in ["lino", "mussola", "voile", "corto", "t-shirt", "pantaloncin", "estivo"]
    ):
        summer_skus.append((sku, name, price, age_str))

print("\n" + "=" * 72)
print("BREAKDOWN GRANULARE MAGAZZINO FARWAY (121 prodotti pubblicati)")
print("=" * 72)

print(f"\n[1] STOCK STATUS: {dict(stock_count)}")
print(f"\n[2] GENRE: {dict(genre_count)}")
print(f"\n[3] TYPE COUNT: {dict(sorted(type_count.items(), key=lambda x: -x[1]))}")
print(f"\n[4] AGE distribution (parsed from SKU):")
for a, n in sorted(age_count.items(), key=lambda x: -x[1]):
    print(f"    {a}: {n}")
print(f"\n[5] SEASON distribution (parsed from SKU):")
for s, n in sorted(season_count.items(), key=lambda x: -x[1]):
    print(f"    {s}: {n}")
print(f"\n[6] PRICE BUCKET:")
for k in [
    "EUR 0 (mancante)",
    "EUR 0-19",
    "EUR 20-39",
    "EUR 40-69",
    "EUR 70-99",
    "EUR 100-149",
    "EUR 150+",
]:
    if k in price_bucket:
        print(f"    {k}: {price_bucket[k]}")

print(f"\n[7] TYPE x GENRE crosstab:")
for t, gd in sorted(type_genre.items(), key=lambda x: -sum(x[1].values())):
    total = sum(gd.values())
    parts = [f"{g}={n}" for g, n in sorted(gd.items())]
    print(f"    {t:20s} [{total:3d}]  {', '.join(parts)}")

print(f"\n[8] TYPE avg price (mean retail):")
for t, prices in sorted(
    type_price_mean.items(),
    key=lambda x: -(sum(x[1]) / len(x[1]) if x[1] else 0),
):
    if prices:
        print(
            f"    {t:20s} EUR {sum(prices)/len(prices):6.2f}  (min EUR {min(prices):.0f}, max EUR {max(prices):.0f}, n={len(prices)})"
        )

print(f"\n[9] CEREMONY CANDIDATES (abiti eleganti / cerimonia): {len(ceremony_skus)}")
for sku, name, price, age in sorted(ceremony_skus, key=lambda x: -x[2])[:20]:
    print(f"    EUR {price:6.2f}  age={age}  [{sku}] {name[:60]}")

print(f"\n[10] NEWBORN CANDIDATES (0-12 mesi + body/tutine): {len(newborn_skus)}")
for sku, name, price, age in sorted(newborn_skus, key=lambda x: -x[2])[:20]:
    print(f"    EUR {price:6.2f}  age={age}  [{sku}] {name[:60]}")

print(f"\n[11] ALL ABITI ({len(abiti_skus)} prodotti):")
for sku, name, price, age, gender in sorted(abiti_skus, key=lambda x: -x[2]):
    print(f"    EUR {price:6.2f}  age={age}  {gender}  [{sku}] {name[:60]}")

print(f"\n[12] ACCESSORI ENTRY-PRICE (gift, <EUR 20): {len(accessory_gift_skus)}")
for sku, name, price in sorted(accessory_gift_skus, key=lambda x: -x[2])[:15]:
    print(f"    EUR {price:6.2f}  [{sku}] {name[:60]}")

print(f"\n[13] SUMMER CANDIDATES (PE + lino/mussola/voile/corto): {len(summer_skus)}")
for sku, name, price, age in sorted(summer_skus, key=lambda x: -x[2])[:15]:
    print(f"    EUR {price:6.2f}  age={age}  [{sku}] {name[:60]}")

print(f"\n[14] SALE PRICED ATTUALMENTE: {len(sale_priced)}")
for sku, name, price, sp in sale_priced[:10]:
    print(f"    EUR {price} -> EUR {sp}  [{sku}] {name[:60]}")

total_retail_value = sum(
    float(p.get("price") or 0) for p in products if p.get("stock_status") == "instock"
)
print(
    f"\n[15] STIMA VALORE RETAIL prodotti in stock (1 unita per SKU): EUR {total_retail_value:.2f}"
)
print(
    f"    Nota: questo e' il valore con 1 unita per SKU. Magazzino reale ha multipli per taglie/colori."
)

print("\n" + "=" * 72)
