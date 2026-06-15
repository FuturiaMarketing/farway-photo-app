# Project Memory - farway-photo-app

## Nome progetto
farway-photo-app

## Descrizione breve
Workspace Next.js dedicato a generazione/gestione asset prodotto e sincronizzazione con WooCommerce.

## Stato del progetto (pre-move)
- Stato progetto: attivo
- Stato repository iniziale: working tree non pulito
- GitHub repo canonico: `https://github.com/FuturiaMarketing/farway-photo-app.git`
- Path locale originale: `C:\Users\fabri\farway-photo-app`
- Path locale destinazione: `C:\Users\fabri\coding\Farway\farway-photo-app`
- Remote git: `origin -> https://github.com/FuturiaMarketing/farway-photo-app.git`
- Branch corrente: `main`
- Presenza `.vercel/project.json`: si
- Presenza `.env.example`: no

## Cosa e gia stato realizzato
- API route per sync WooCommerce e gestione asset (`app/api/*`)
- Persistenza stato/sessione e impostazioni applicative
- Script di arricchimento prodotto (`scripts/farway-enrich-products.cjs`)

## Funzionalita/workflow gia operativi
- Avvio sviluppo locale: `npm run dev`
- Build/start Next.js: `npm run build`, `npm run start`
- Lint: `npm run lint`
- Arricchimento batch prodotto: `node scripts/farway-enrich-products.cjs`

## Script utili
- `dev`
- `build`
- `start`
- `lint`

## Classificazione env (chiavi note, senza valori)
| Chiave | Destinazione | Note |
| --- | --- | --- |
| APP_PUBLIC_URL | shared non-secret | URL pubblica applicazione |
| DATABASE_URL | Vercel | In locale resta in `.env.local`; per deploy usare Vercel env |
| GOOGLE_GENERATIVE_AI_API_KEY | Vercel | Secret runtime |
| IONOS_PASSWORD | locale per-user | Credenziale locale utente |
| IONOS_USERNAME | locale per-user | Credenziale locale utente |
| IONOS_PORT | machine-specifico | Parametro macchina/host |
| IONOS_PROTOCOL | shared non-secret | Configurazione protocollo |
| IONOS_HOST | shared non-secret | Endpoint server |
| WC_CONSUMER_KEY | Vercel | Secret integrazione WooCommerce |
| WC_CONSUMER_SECRET | Vercel | Secret integrazione WooCommerce |
| WC_STORE_URL | shared non-secret | Base URL store |

## Quali env devono stare su Vercel
- `DATABASE_URL`
- `GOOGLE_GENERATIVE_AI_API_KEY`
- `WC_CONSUMER_KEY`
- `WC_CONSUMER_SECRET`

## Quali env devono restare locali per macchina
- `.env.local` resta locale e non versionata
- Credenziali/parametri IONOS usati per tooling locale

## Dipendenze esterne non da spostare
- Store WooCommerce remoto
- Endpoint/credenziali IONOS
- Progetto Vercel collegato (`.vercel/project.json`)

## Decisioni architetturali importanti
- GitHub e la fonte di verita del codice condiviso
- Workspace locale e clone operativo
- Secret mai in file condivisi/versionati

## Convenzioni tecniche e naming
- `_local/assistant-memory.md` come memoria locale canonica cross-tool
- Nessun rename di `.env.local`

## Integrazioni e gestione auth
| integrazione | scopo | fonte auth | file/env/tool usato | livello di condivisione | note operative |
| --- | --- | --- | --- | --- | --- |
| WooCommerce | Sync prodotti/metadata | `.env.local` / Vercel env | `WC_STORE_URL`, `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET` | deployment-only | Chiavi secret non in repo |
| Gemini API | Generazione contenuti/asset | `.env.local` / Vercel env | `GOOGLE_GENERATIVE_AI_API_KEY` | deployment-only | Rotazione chiavi fuori dal repo |
| IONOS FTP | Operazioni file esterne | `.env.local` | `IONOS_*` | machine-specific | Parametri dipendono da macchina/sessione |
| Vercel | Deploy e runtime env | tool/sessione locale + `Vercel env` | `.vercel/project.json` | shared | Secret deploy su dashboard Vercel |

## Gotcha, rischi e cose da non rompere
- Repository con modifiche locali non committate: non ripulire automaticamente
- Presenza file temporanei locali (`.tmp_*`, `.tmp_media`) da preservare

## Checklist post-move
- Verificare `.git`, branch e remote
- Verificare presenza `package.json`, `.env.local`, `.vercel/project.json`
- Verificare `git status --short --branch` invariato rispetto al pre-move

## Prossimi passi consigliati
- Aggiungere `.env.example` minimale senza valori
- Consolidare documentazione API principali in `docs/`

## Esito migrazione
In preparazione (pre-move): documentazione e memoria create prima dello spostamento.

## Aggiornamento post-migrazione (2026-03-11)
- Path finale effettivo: `C:\Users\fabri\coding\Farway\farway-photo-app`
- Vecchio path: rimosso (`C:\Users\fabri\farway-photo-app` non piu presente)
- Verifiche:
  - `.git`: presente
  - remote: `origin -> https://github.com/FuturiaMarketing/farway-photo-app.git`
  - `package.json`: presente
  - `.env.local`: presente
  - `.vercel/project.json`: presente
  - `git status --short --branch`: invariato rispetto al pre-move
  - `npm run lint`: fallito su regola ESLint (`@typescript-eslint/no-require-imports`) in `scripts/farway-enrich-products.cjs`
- Problemi rilevati: nessuna regressione da move; presente debt lint preesistente.
- Esito migrazione: pass con warning lint preesistente.

## Aggiornamento MCP WooCommerce (2026-03-17)
- Configurazione MCP persistente aggiornata in `C:\Users\fabri\.codex\config.toml` con server `mcp_servers.woocommerce` su bridge stdio locale.
- Bridge operativo: `C:\Users\fabri\mcp-servers\woocommerce-mcp\woocommerce-mcp-stdio-proxy.mjs`.
- Env file canonico per Woo MCP: `C:\Users\fabri\coding\Farway\farway-photo-app\.env.local` (chiavi supportate: `WC_STORE_URL`, `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET`; fallback opzionale `WP_MCP_API_URL`, `WP_MCP_API_KEY`).
- Test operativo di connessione confermato con `initialize` + `tools/list` (9 tool WooCommerce).
- Nota PowerShell: nei test con `Invoke-WebRequest` usare sempre `-UseBasicParsing` per evitare prompt interattivi di sicurezza.
