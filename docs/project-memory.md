# Project Memory - farway-photo-app

## Nome progetto
farway-photo-app

## Descrizione breve
Workspace Next.js per generazione/gestione asset prodotto e sincronizzazione con WooCommerce.

## Cosa è già stato realizzato
- API route per sync WooCommerce e gestione asset (`app/api/*`)
- Persistenza stato/sessione e impostazioni applicative
- Script di arricchimento e gestione catalogo prodotto (`scripts/*`)
- Script `scripts/farway-reconcile-gallery-import.cjs` per riconciliare le foto still life nella galleria immagini WooCommerce del prodotto: legge `photo_matches/decisions` da Postgres, considera solo decisioni `confirmed` con `productId` e file ancora presente nel livello principale della cartella still life pulita, carica i file locali nella Media Library, aggiorna solo `product.images` e può rimuovere/cancellare i media gestiti non più presenti nella cartella.

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
- Le foto riconciliate non vanno collegate alle varianti colore: una variante colore può avere una sola foto e si preservano quelle esistenti. L'import still life usa solo la galleria prodotto, non salva la `colorway` nel payload immagini e non chiama endpoint `products/{id}/variations/*` in scrittura. La fonte di verità per evitare doppioni è la cartella still life pulita, solo file al livello principale; `_da-verificare` e sottocartelle restano fuori.
- Per le chiamate server-side a WordPress/WooCommerce dopo il cutover, preferire l'origin tecnico `FARWAY_WP_ORIGIN` quando disponibile: l'apex pubblico `farwaymilano.com` può essere protetto da Vercel e bloccare le REST API dirette.

## Cose da non rompere
- Non versionare `.env.local` né le cartelle/working file locali (`_local/`, `.tmp_*`).
- Non committare i dump dati sotto `data/`.
