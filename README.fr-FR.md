# DSH with ChatGPT

**ChatGPT réfléchit. DSH exécute.**

Un portage pour DSH de [codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt) :
le ChatGPT web devient le cerveau de planification et de revue de votre espace de travail local,
tandis que l'agent DSH conserve la propriété de l'exécution — édition de fichiers, shell, tests.

Pas de clé d'API, pas de proxy inverse. ChatGPT accède à votre espace de travail via un
**connecteur MCP en lecture seule** au travers d'un tunnel cloudflared officiel, en utilisant
l'abonnement ChatGPT que vous payez déjà.

- **L'espace de travail est la frontière** : chaque chemin est résolu à l'intérieur de la racine
  configurée — les jonctions NTFS et les liens symboliques ne peuvent pas s'en échapper.
- **Lecture seule par construction** : les outils d'écriture / suppression / shell / commit
  n'existent pas, plutôt que d'être « désactivés ».
- **OAuth 2.1** (PKCE S256, enregistrement dynamique de client, refresh tokens rotatifs avec
  révocation de famille) plus un code d'appariement à usage unique — la seule information
  d'identification que l'utilisateur saisit.
- **Les messages de contrôle restent sous 1 Ko** : l'intention, jamais le contenu. Pas de diffs,
  pas de journaux, pas de corps de fichiers.

> 🌐 Autres langues : [English](README.md) · [中文](README.zh-CN.md) · [Français](README.fr-FR.md) · [Русский](README.ru-RU.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

## Installation en une commande (instruction à l'agent)

Une fois DSH installé, dites cette seule phrase à votre agent — elle couvre tout, du clone
à l'activation :

```text
Before using ChatGPT for planning: clone https://github.com/SakuYayin/dsh-with-ChatGPT
locally, install that directory with the plugin manager's install_bundle, then run
/chatgpt setup and tell me the printed connector URL and pairing code.
```

Ou étape par étape (équivalent) :

```powershell
git clone https://github.com/SakuYayin/dsh-with-ChatGPT.git
dsh plugin install .\dsh-with-ChatGPT
```

Après l'installation, exécutez `/chatgpt setup` dans une session DSH (ou faites appel par
l'agent à l'action `setup` de l'outil `c2c_setup`). Cela démarre le tunnel, génère un code
d'appariement et affiche cette liste de vérification :

```text
DSH with ChatGPT
✓ Current project recognized (my-project)
✓ Workspace Bridge started
✓ Secure connection established
✓ ChatGPT connected
✓ Pairing code generated
Ready.
```

## Connecter ChatGPT (une seule fois, ~2 minutes)

1. ChatGPT → **Settings → Connectors → Create**. La description est libre, URL = l'adresse du
   connecteur affichée ci-dessus, Authentication = **OAuth**
   (le mode développeur peut être requis : `chatgpt.com/#settings/Security`).
2. Ouvrez le connecteur ; la page d'appariement demande le **code d'appariement à 8 symboles**
   affiché ci-dessus (TTL de 5 minutes, à usage unique).
3. Collez les **Project instructions** (également affichées par `c2c_setup`) dans les paramètres
   du projet ChatGPT. Ne collez que le **nom** du connecteur — jamais l'URL du connecteur.

À partir de là, dites **« Use ChatGPT to plan <goal> »** dans DSH. L'agent appelle `c2c_start`
et la boucle s'exécute :

```text
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

ChatGPT envoie `PLAN`/`DONE`/`BLOCKED`/`HANDOFF` via `control_submit` ; l'agent DSH les
récupère avec `c2c_inbox`. Le budget d'itération vaut 12 par défaut ; une fois atteint,
l'agent se met en pause et demande.

## Outils

Le plugin enregistre deux groupes.

**Outils côté agent (DSH, orchestration de la boucle)**

| Outil | Rôle |
|---|---|
| `c2c_start` | Démarrer une boucle : id de tâche + message INIT + prompt de démarrage |
| `c2c_inbox` | Récupérer les PLAN/DONE/BLOCKED/HANDOFF de ChatGPT, faire avancer le point de contrôle |
| `c2c_record` | Enregistrer l'exécution (fichiers, tests, sortie assainie) |
| `c2c_executed` | Construire le message EXECUTED (compteurs et ligne de test uniquement) |
| `c2c_handoff` | Récupérer une conversation ChatGPT perdue avec un brief de 1 Ko |
| `c2c_session` | Lire / définir / effacer le point de contrôle local |
| `c2c_setup` | Statut, tunnel, code d'appariement, Project instructions |

**Outils MCP (côté ChatGPT, lecture seule)**

`workspace_info`, `list_directory`, `read_file`, `search_workspace`, `git_status`,
`git_diff`, `test_status`, `execution_summary`, `execution_output`, `read_image`,
plus `control_submit` / `control_inbox` pour le plan de contrôle.

Les fichiers sensibles (`.env*`, clés, matériel SSH, identifiants) sont refusés par défaut —
`.env.example` reste lisible. `.c2cignore` ajoute des règles propres au projet. La sortie des
commandes est assainie localement avant que ChatGPT puisse la voir : les clés privées et les
tokens sont retirés entièrement, les éléments restreints apparaissent dans les listes sans
corps.

## Configuration

| Clé | Valeur par défaut | Signification |
|---|---|---|
| `enabled` | `true` | Désactiver le plugin sans le désinstaller |
| `workspace` | `''` | Racine de l'espace de travail ; vide = le répertoire de travail de la session |
| `prefix` | `/dsh-with-chatgpt` | Point de montage HTTP, maintenu relatif pour que le point d'accès survive à un changement de port |
| `connectorName` | `''` | Libellé du connecteur ChatGPT ; vide = `DSH with ChatGPT (<workspace>)` |
| `maxIterations` | `12` | Budget souple de la boucle avant mise en pause pour l'utilisateur |
| `autoStartTunnel` | `false` | Démarrer le tunnel public avec le bridge |
| `tunnel` | `quick` | `quick` (`*.trycloudflare.com`, change à chaque redémarrage) ou `named` |
| `cloudflaredPath` | `''` | Chemin explicite du binaire |
| `publicOrigin` | `''` | Origine publique fixe quand le tunnel est géré en externe ; le bridge rapporte cette URL au lieu de lancer son propre processus enfant |
| `tunnel.token` / `tunnel.hostname` / `tunnel.tunnelName` / `tunnel.configPath` | `''` | Options du tunnel nommé : un token (ingress géré à distance) **ou** un fichier de config local + un nom de tunnel (`--config <path> … run <name>`) ; hostname définit l'URL rapportée |
| `limits` | voir ci-dessous | `maxFileBytes` 128 Kio, `maxDiffBytes` 96 Kio, `maxOutputBytes` 64 Kio, `maxOutputLines` 600, `maxImageBytes` 4 Mio |

### Choisir un tunnel : répondre à une question

> **« Possédez-vous un domaine ? »**

```text
        ┌─ Own a domain (e.g. example.com)? ──→ Route A: fixed domain, configure once
        │
        └─ No domain? ───────────────────────→ Route B: quick tunnel, zero config
```

---

#### Route A : vous avez un domaine — 5 étapes, à configurer une fois pour toutes

Ce qu'il vous faut : un domaine hébergé chez Cloudflare (le plan gratuit suffit) et un
`cloudflared` fonctionnel.

> 💡 Cela se fait une seule fois. L'URL du connecteur ne change plus ensuite, quel que soit
> le nombre de redémarrages.

1. **Connectez-vous** (un navigateur s'ouvre ; cliquez pour autoriser) :

   ```powershell
   cloudflared tunnel login
   ```

2. **Créez le tunnel** (`my-bridge` est un nom, choisissez n'importe lequel, retenez-le) :

   ```powershell
   cloudflared tunnel create my-bridge
   ```

3. **Faites pointer le domaine vers le tunnel** (remplacez `dsh.example.com` par votre
   sous-domaine) :

   ```powershell
   cloudflared tunnel route dns my-bridge dsh.example.com
   ```

4. **Écrivez la configuration** `C:\Users\<you>\.cloudflared\bridge.yml` (l'UUID et le nom de
   fichier json proviennent de la sortie de l'étape 2 — copiez-les) :

   ```yaml
   tunnel: <UUID from step 2>
   credentials-file: C:/Users/<you>/.cloudflared/<same UUID>.json
   ingress:
     - hostname: dsh.example.com
       service: http://127.0.0.1:3780
     - service: http_status:404
   ```

5. **Démarrez le tunnel + indiquez-le au plugin**. Testez d'abord manuellement :

   ```powershell
   cloudflared tunnel --config "C:/Users/<you>/.cloudflared/bridge.yml" --no-autoupdate run my-bridge
   ```

   Voir `Registered tunnel connection` signifie que cela fonctionne. Configurez ensuite le
   plugin (`cordis.patch.yml` ou Settings → page ChatGPT) :

   ```yaml
   config:
     publicOrigin: 'https://dsh.example.com'
     autoStartTunnel: false        # the tunnel is already running manually
     tunnel:
       mode: named
       tunnelName: my-bridge
       configPath: 'C:/Users/<you>/.cloudflared/bridge.yml'
   ```

   ✅ **Vérification** : ouvrez `https://dsh.example.com/dsh-with-chatgpt` dans un navigateur ;
   voir `bridge is running` signifie que c'est terminé. Vous voulez qu'il démarre à
   l'ouverture de session ? Dites à l'agent :
   « install cloudflared as a logon scheduled task ».

---

#### Route B : pas de domaine — zéro configuration, fonctionne immédiatement

Rien à acheter, rien à enregistrer. `/chatgpt setup` démarre automatiquement un tunnel rapide
et affiche sur place une URL du style
`https://xxxx.trycloudflare.com/dsh-with-chatgpt/mcp`.

- ✅ Zéro configuration, fonctionne juste après l'installation
- ⚠️ Le seul inconvénient : **l'URL change quand DSH redémarre** — mettez à jour l'URL du
  connecteur dans ChatGPT (et ressaisissez le code d'appariement, une corvée de 30 secondes)

Aucune modification de configuration n'est nécessaire ; cette route est celle par défaut.
Passez directement aux trois étapes « Connecter ChatGPT » ci-dessus.

> 💡 Exécutez d'abord la route B pour valider l'ensemble du flux ; passez à la route A dès que
> vous voulez une adresse fixe — la bascule ne tient qu'aux quelques lignes yaml ci-dessus.

---

### Domaine fixe (référence avancée)

La logique derrière la route A (équivalente aux étapes ci-dessus, pour le dépannage) :
l'URL d'un tunnel rapide change à chaque redémarrage, tandis qu'un tunnel nommé établit par
CNAME un sous-domaine fixe vers votre tunnel, rendant l'URL permanente :

```powershell
cloudflared tunnel login
cloudflared tunnel create my-bridge
cloudflared tunnel route dns my-bridge dsh.example.com
```

Écrivez `~/.cloudflared/bridge.yml` :

```yaml
tunnel: <tunnel-uuid>
credentials-file: C:/Users/<you>/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:3780
  - service: http_status:404
```

Exécutez-le (par exemple une tâche planifiée à l'ouverture de session), puis définissez dans
`cordis.patch.yml` :

```yaml
- insert:
    - id: dsh-with-chatgpt
      name: dsh-with-chatgpt
      config:
        publicOrigin: 'https://dsh.example.com'
        autoStartTunnel: false   # an external supervisor owns the tunnel
        tunnel:
          mode: named
          tunnelName: my-bridge
          configPath: 'C:/Users/<you>/.cloudflared/bridge.yml'
```

## Différences par rapport à l'original

L'amont (codex-with-chatgpt) livre une CLI Node plus un Codex Skill et pilote le côté ChatGPT
en tapant des messages `[C2C]` dans l'interface web. DSH n'a aucune surface d'automatisation
de navigateur, donc ce plugin remplace cette moitié par deux outils MCP de plan de contrôle :

| En amont | Ici |
|---|---|
| CLI `c2c setup` / `c2c status` | Commande `/chatgpt` + page de paramètres + outil `c2c_setup` |
| Fichier Codex Skill | Section `systemPrompt` installée par le plugin |
| « Computer Use » tape dans ChatGPT | Outils MCP `control_submit` / `control_inbox` |
| `c2c record` / `session --json` | Outils `c2c_record`, `c2c_session` + journal JSONL |
| Écran de statut de bureau | Panneau Settings → **ChatGPT** (slot React, tokens de thème DSH) |

Même protocole, même format de message, même posture de sécurité, même prompt de démarrage à
13 règles — la moitié ChatGPT est inchangée et la documentation amont reste applicable.

## Sécurité

- Le point d'accès MCP exige toujours un bearer token OAuth — le tunnel le rend publiquement
  accessible.
- L'API d'état (`/api/*`) ne répond qu'en boucle locale et refuse en outre toute requête
  portant des en-têtes de tunnel, un `Host` hors boucle locale ou un `Origin` intersites — une
  requête `cloudflared` arrive aussi depuis un socket en boucle locale, donc la seule vérification
  du socket ne suffirait pas.
- Les codes d'appariement comportent 8 symboles, TTL de 5 minutes, usage unique, 5 tentatives,
  limitation de débit par IP.
- Le rejeu d'un refresh-token révoque toute la famille de tokens.
- Le confinement des chemins utilise `realpathSync.native`, donc les jonctions NTFS ne peuvent
  pas s'échapper de la racine.

## Tests

```powershell
node --test --experimental-test-isolation=none tests/auth.test.js
node --test --experimental-test-isolation=none tests/mcp.test.js
node --test --experimental-test-isolation=none tests/tunnel.test.js
node --test --experimental-test-isolation=none tests/workspace.test.js
node --test --experimental-test-isolation=none tests/http.test.js
```

`--experimental-test-isolation=none` n'est nécessaire que dans un sandbox qui interdit le stdio
des processus enfants via un tube ; un shell normal exécute un simple `node --test` sans problème.

## Licence

MIT, comme l'original.
