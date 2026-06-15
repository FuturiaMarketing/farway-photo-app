# Project Memory - farway-photo-app

## Nome progetto
farway-photo-app

## Descrizione breve
Workspace Next.js per generazione/gestione asset prodotto e sincronizzazione con WooCommerce.

## Cosa è già stato realizzato
- API route per sync WooCommerce e gestione asset (`app/api/*`)
- Persistenza stato/sessione e impostazioni applicative
- Script di arricchimento e gestione catalogo prodotto (`scripts/*`)

## Script npm
- `npm run dev` — sviluppo locale
- `npm run build` / `npm run start` — build e avvio Next.js
- `npm run lint` — lint

## Configurazione ed env
- Le variabili d'ambiente in locale vivono in `.env.local` (non versionato).
- In produzione sono configurate come Vercel environment variables.
- I secret non sono mai versionati nel repo. Le variabili richieste sono referenziate nel codice via `process.env`.

## Decisioni architetturali
- GitHub è la fonte di verità del codice condiviso; il workspace locale è un clone operativo.
- Secret e credenziali mai in file versionati.
- Integrazioni esterne (store WooCommerce, provider di generazione contenuti, Vercel) configurate via env, non hardcoded.

## Cose da non rompere
- Non versionare `.env.local` né le cartelle/working file locali (`_local/`, `.tmp_*`).
- Non committare i dump dati sotto `data/`.
