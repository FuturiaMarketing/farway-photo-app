# Agent Rules - farway-photo-app

## Regole operative
- Trattare GitHub come source of truth del codice condiviso.
- Trattare la cartella locale come working copy.
- Evitare modifiche distruttive (`git reset --hard`, cleanup aggressivo) senza richiesta esplicita.

## Limiti e vincoli
- Non versionare `_local/`.
- Non esporre o copiare valori da `.env.local` in file condivisi.
- Per deploy usare secret su Vercel, non nel repository.

## Convenzioni di modifica
- Cambiamenti mirati, verificabili e reversibili.
- Aggiornare sempre `docs/project-memory.md` quando cambia un'integrazione o workflow.

## File da leggere prima di lavorare
- `README.md`
- `docs/project-memory.md`
- `docs/project-index.md`
- `_local/assistant-memory.md`

## Procedure sicure per interventi futuri
1. Controllare `git status --short --branch`.
2. Verificare presenza `.env.local` e `.vercel/project.json`.
3. Eseguire solo check leggeri (`lint/typecheck`) se pronti senza setup extra.
4. Annotare esito in documentazione/memoria.
5. Nei test HTTP PowerShell con `Invoke-WebRequest`, usare `-UseBasicParsing` per evitare prompt interattivi.

## Cose da evitare
- Spostare secret in file versionati.
- Rinominare `.env.local`.
- Alterare path esterni non legati al progetto senza analisi d'impatto.
