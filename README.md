# Gestión de Ventas y Comisiones

Una sola base di codice, tre modi di usarla:

| Parte | Dove vive | Come si aggiorna |
|---|---|---|
| Backend (`src/Code.gs`, `src/Setup.gs`) | Google Apps Script (fogli + Drive) | push su GitHub → `clasp push` automatico |
| Frontend PWA (`src/Index.html`) | GitHub Pages (installabile su cellulare) | push su GitHub → build + deploy automatico |
| Stesso frontend dentro Apps Script | URL `/exec` (continua a funzionare) | come il backend |

`Index.html` rileva da solo dove gira: dentro Apps Script usa `google.script.run`, su GitHub Pages usa `fetch` verso l'URL `/exec` (`doPost` in `Code.gs`).

Sincronizzazione:
- **GitHub → Apps Script**: ogni push su `main` che modifica `src/` (workflow *Deploy to Apps Script*).
- **Apps Script → GitHub**: ogni 30 min (e a richiesta) viene fatto `clasp pull`; se hai modificato qualcosa nell'editor viene committato su `main` (workflow *Sync from Apps Script*).
- Modifica da **un solo lato alla volta**: se tocchi lo stesso file in entrambi i posti prima della sync, vince l'ultimo che arriva.

## Configurazione (una volta sola)

### 1. Apps Script
1. Impostazioni utente → https://script.google.com/home/usersettings → attiva **Google Apps Script API**.
2. Nel progetto: Impostazioni progetto → copia lo **ID script**.
3. Incolla il contenuto di `src/Code.gs` e `src/Index.html` (versioni nuove) nell'editor, oppure salta questo passo e lascia fare al primo deploy da GitHub.
4. Distribuisci → **Gestisci distribuzioni** → modifica la distribuzione web app esistente:
   *Esegui come*: **Io** · *Chi ha accesso*: **Chiunque**. Salva e copia l'**ID distribuzione** e l'URL `/exec`.
   (L'app ha già il suo login con token, quindi l'accesso "Chiunque" serve solo perché GitHub Pages possa chiamare l'API.)
5. `src/appsscript.json` è un manifest di base: se il tuo ha altri scope/impostazioni, esegui prima `clasp pull` in locale e tienilo.

### 2. Credenziali clasp per GitHub
In locale: `npm i -g @google/clasp@2.4.2 && clasp login`, poi copia il contenuto di `~/.clasprc.json`.

### 3. Repository GitHub
Settings → Secrets and variables → Actions:
- Secrets: `CLASPRC_JSON` (contenuto di `.clasprc.json`), `SCRIPT_ID`, `DEPLOYMENT_ID`
- Variables: `GAS_WEBAPP_URL` (l'URL `/exec`)

Settings → Pages → Source: **GitHub Actions**.

Poi `git push` su `main`. L'app sarà su `https://<utente>.github.io/<repo>/`.

## Installazione sul cellulare
- **Android (Chrome)**: menu ⋮ → *Installa app*.
- **iPhone (Safari)**: Condividi → *Aggiungi alla schermata Home*.

L'icona è `web/icons/` (generata da `icona.png`; versioni 192/512, maskable per Android e 180 px senza trasparenza per iOS).
Se cambi icona, rigenera quei file e fai push.

## Note
- Dentro Apps Script non esiste un vero PWA (niente manifest né icona Home): per l'installazione usa l'URL GitHub Pages.
- Sulla PWA la sessione resta salvata (localStorage) fino a 6 h di inattività; dentro Apps Script resta sessionStorage.
- Ogni deploy crea una versione dello script (limite 200): elimina le vecchie da *Gestisci distribuzioni* ogni tanto.
- Test rapido del backend: apri `URL/exec?api=ping` → `{"ok":true,"data":"pong"}`.
