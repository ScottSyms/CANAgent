// The demo's narration — single source of truth for BOTH the TTS voiceover and
// the generated docs/demo/SCRIPT.md.
//
// Narration is written in BEATS, each anchored to a named checkpoint that the
// scene emits with mark() at the exact moment the narrated thing appears on
// screen. record.ts cuts the scene's footage at those marks and pads each
// chunk to its beat's audio length — so a sentence starts when its action
// starts, and the video holds (never mid-action) when a sentence outruns the
// screen. Every beat must describe ONLY what is visible from its mark onward;
// write narration and scene code as a pair.
//
// The first beat of every scene is anchored at 'start' (scene time zero).

export interface Beat {
  mark: string;
  text: string;
}

export type DemoLang = 'en' | 'fr';

export interface SceneDef {
  id: string;
  title: string;
  /** What the viewer sees — used for the SCRIPT.md action column. */
  action: string;
  beats: Record<DemoLang, Beat[]>;
}

export const SCENES: SceneDef[] = [
  {
    id: 'title',
    title: 'Title card',
    action: 'Branded title card.',
    beats: {
    en: [
      {
        mark: 'start',
        text:
          'CANChat Agent is an A I agent that lives in your browser’s side panel — and uses the browser itself as its toolset. Over the next few minutes we’ll set it up from scratch, on real pages, and walk through every major feature.',
      },
    ],
    fr: [
      { mark: 'start', text:
        'CANChat Agent est un agent d’intelligence artificielle qui vit dans le panneau latéral de votre navigateur — et qui utilise le navigateur lui-même comme boîte à outils. Dans les prochaines minutes, nous allons le configurer à partir de zéro, sur de vraies pages, et parcourir chacune de ses fonctions.' },
    ],
    },
  },
  {
    id: 'onboarding',
    title: 'First run — connect a model',
    action: 'Live Wikipedia page on the left; onboarding card in the panel: fill three fields, Test connection, Save & start.',
    beats: {
    en: [
      {
        mark: 'start',
        text:
          'On first run, the panel shows a short welcome beside whatever you’re reading — here, the Wikipedia article on the Rideau Canal. It asks for just three things: an endpoint, a key, and a model.',
      },
      {
        mark: 'typed',
        text:
          'Any OpenAI-compatible endpoint works — a cloud A P I, a local model, or your organization’s gateway. The key is stored only on this device, never synced.',
      },
      { mark: 'tested', text: 'Test connection sends one tiny request, and reports plainly that it worked.' },
      { mark: 'ready', text: 'Save and start — and that’s the whole setup.' },
    ],
    fr: [
      { mark: 'start', text:
        'Au premier lancement, le panneau affiche un court accueil à côté de votre lecture — ici, l’article Wikipédia sur le canal Rideau. Il ne demande que trois choses : un point de terminaison, une clé, et un modèle.' },
      { mark: 'typed', text:
        'N’importe quel point de terminaison compatible OpenAI fonctionne — une A P I infonuagique, un modèle local, ou la passerelle de votre organisation. La clé reste uniquement sur cet appareil.' },
      { mark: 'tested', text:
        'Tester la connexion envoie une seule petite requête, et confirme clairement que ça fonctionne.' },
      { mark: 'ready', text:
        'Enregistrer et démarrer — et la configuration est terminée.' },
    ],
    },
  },
  {
    id: 'summarize',
    title: 'Ask about the current page',
    action: 'Types a question; the agent reads the live article and answers with a real summary.',
    beats: {
    en: [
      {
        mark: 'start',
        text: 'The simplest thing you can do: ask about the page you’re on.',
      },
      {
        mark: 'asked',
        text:
          'The question goes in the composer in plain language. Watch the status pill — thinking, then acting, as the agent reads the tab.',
      },
      {
        mark: 'answered',
        text:
          'And the answer is a genuine summary of this article — the canal’s length, its heritage status, the winter Skateway — with a one-click copy button and the source cited.',
      },
    ],
    fr: [
      { mark: 'start', text:
        'La chose la plus simple : poser une question sur la page ouverte.' },
      { mark: 'asked', text:
        'La question s’écrit en langage courant. Observez la pastille d’état — réflexion, puis navigation, pendant que l’agent lit l’onglet.' },
      { mark: 'answered', text:
        'Et la réponse est un vrai résumé de cet article — la longueur du canal, son statut patrimonial, la patinoire d’hiver — avec un bouton copier et la source citée.' },
    ],
    },
  },
  {
    id: 'plan',
    title: 'Research with a live plan',
    action: 'A research task: plan appears, real tabs open across the fake tab strip, synthesis cites all sources; tool log expanded.',
    beats: {
    en: [
      { mark: 'start', text: 'For bigger tasks, the agent plans in the open. Let’s ask it to compare Canada’s historic waterways.' },
      { mark: 'planned', text: 'It lays out its plan first — four steps, each ticked off as it completes.' },
      {
        mark: 'tabs',
        text:
          'Then it opens real sources — watch the tab strip: the Northwest Passage and the Trent–Severn Waterway open as live tabs, gathered into this conversation’s tab group.',
      },
      { mark: 'answered', text: 'The synthesis draws on every tab it opened, and lists them as sources.' },
      { mark: 'activity', text: 'And the tool activity log keeps the full trace — every call the agent made, in order.' },
    ],
    fr: [
      { mark: 'start', text:
        'Pour les tâches plus ambitieuses, l’agent planifie au grand jour. Demandons-lui de comparer les voies navigables historiques du Canada.' },
      { mark: 'planned', text:
        'Il établit d’abord son plan — quatre étapes, cochées au fur et à mesure.' },
      { mark: 'tabs', text:
        'Puis il ouvre de vraies sources — regardez la barre d’onglets : le passage du Nord-Ouest et la voie navigable Trent-Severn s’ouvrent comme onglets réels, regroupés pour cette conversation.' },
      { mark: 'answered', text:
        'La synthèse s’appuie sur chaque onglet ouvert, et les cite comme sources.' },
      { mark: 'activity', text:
        'Et le journal d’activité des outils garde la trace complète — chaque appel, dans l’ordre.' },
    ],
    },
  },
  {
    id: 'approval',
    title: 'Approvals — you stay in control',
    action: 'A state-changing action raises the approval card; Approve runs it; the answer reports the page’s real title.',
    beats: {
    en: [
      { mark: 'start', text: 'Now the most important design decision: consent.' },
      {
        mark: 'card',
        text:
          'Running code inside a page changes state, so the agent stops and asks first. The card leads with a plain-language reason; the mechanics sit under the technical-detail toggle. Nothing outbound ever happens silently.',
      },
      { mark: 'approved', text: 'Approve it, and the action runs — the agent reads and reports this page’s real title. Deny it, and nothing happens at all.' },
    ],
    fr: [
      { mark: 'start', text:
        'Maintenant, le choix de conception le plus important : le consentement.' },
      { mark: 'card', text:
        'Exécuter du code dans une page modifie l’état, alors l’agent s’arrête et demande d’abord. La carte commence par une raison en langage clair; les détails techniques restent accessibles. Rien ne part jamais en silence.' },
      { mark: 'approved', text:
        'Approuvez, et l’action s’exécute — l’agent lit et rapporte le vrai titre de cette page. Refusez, et rien ne se passe du tout.' },
    ],
    },
  },
  {
    id: 'knowledge',
    title: 'Knowledge bases',
    action: 'Workspace Knowledge page: upload a briefing note; back in the panel, a # reference searches it and the answer cites the note.',
    beats: {
    en: [
      {
        mark: 'start',
        text: 'Knowledge bases are on-device document stores. In the workspace, drop in files — or index whole folders.',
      },
      {
        mark: 'uploaded',
        text: 'This briefing note is parsed and embedded right on the machine. Nothing is uploaded anywhere.',
      },
      { mark: 'panel', text: 'Back in the panel, a hash sign references the base by name.' },
      { mark: 'answered', text: 'The agent searches the note and answers from it — the canal’s navigation season, with the source file cited.' },
    ],
    fr: [
      { mark: 'start', text:
        'Les bases de connaissances sont des dépôts de documents sur l’appareil. Dans l’espace de travail, déposez des fichiers — ou indexez des dossiers entiers.' },
      { mark: 'uploaded', text:
        'Cette note d’information est analysée et vectorisée directement sur la machine. Rien n’est téléversé nulle part.' },
      { mark: 'panel', text:
        'De retour dans le panneau, le carré référence la base par son nom.' },
      { mark: 'answered', text:
        'L’agent interroge la note et répond à partir d’elle — la saison de navigation du canal, avec le fichier source cité.' },
    ],
    },
  },
  {
    id: 'history',
    title: 'History, undo, and the More menu',
    action: 'History overlay with generated title and summary; the ⋯ More menu with text-size, save, undo.',
    beats: {
    en: [
      { mark: 'start', text: 'Every conversation is saved automatically — there is no save button to forget.' },
      { mark: 'opened', text: 'Each thread gets a generated title and a one-line summary, with search, sorting, and colour labels.' },
      {
        mark: 'more',
        text:
          'The three-dot menu holds the everyday extras: the text-size control, saving the conversation as a file, and undoing the last exchange.',
      },
      { mark: 'done', text: 'And New Chat starts fresh — the old thread stays safely in history.' },
    ],
    fr: [
      { mark: 'start', text:
        'Chaque conversation est enregistrée automatiquement — aucun bouton à ne pas oublier.' },
      { mark: 'opened', text:
        'Chaque fil reçoit un titre et un résumé générés, avec recherche, tri, et étiquettes de couleur.' },
      { mark: 'more', text:
        'Le menu à trois points regroupe les extras du quotidien : la taille du texte, l’enregistrement de la conversation, et l’annulation du dernier échange.' },
      { mark: 'done', text:
        'Et Nouvelle conversation repart à neuf — l’ancien fil reste bien dans l’historique.' },
    ],
    },
  },
  {
    id: 'skills',
    title: 'Skills and app playbooks',
    action: 'Workspace Skills page with the seeded skills; back in the panel, slash-command autocomplete.',
    beats: {
    en: [
      {
        mark: 'start',
        text:
          'Skills are procedures you teach the agent once and reuse forever — written by hand, imported, or installed from the shared playbook library.',
      },
      { mark: 'slash', text: 'Each one becomes a slash command: type a slash in the composer and pick it from the menu.' },
    ],
    fr: [
      { mark: 'start', text:
        'Les compétences sont des procédures qu’on enseigne une fois à l’agent — écrites à la main, importées, ou installées depuis la bibliothèque de guides.' },
      { mark: 'slash', text:
        'Chacune devient une commande barre oblique : tapez une barre dans le compositeur et choisissez-la dans le menu.' },
    ],
    },
  },
  {
    id: 'workspace',
    title: 'The Workspace console',
    action: 'Models page with the Advanced section scrolled through; then Memory, Automations (seeded run history), Products.',
    beats: {
    en: [
      {
        mark: 'start',
        text: 'The settings gear opens the workspace — a full tab with a page for everything. Models holds the connection and every advanced option.',
      },
      { mark: 'scrolled', text: 'Behaviour, generation, embeddings, connected services — one page, one scroll.' },
      { mark: 'memory', text: 'Memory shows what the agent has learned about you — searchable and fully editable.' },
      { mark: 'automations', text: 'Automations runs scheduled tasks and site triggers unattended — here’s this morning’s news brief, run on schedule.' },
      { mark: 'products', text: 'And the files those runs produce land in Products, kept on-device and ready to download.' },
    ],
    fr: [
      { mark: 'start', text:
        'L’engrenage des paramètres ouvre l’espace de travail — un onglet complet avec une page pour tout. Modèles regroupe la connexion et toutes les options avancées.' },
      { mark: 'scrolled', text:
        'Comportement, génération, vectorisation, services connectés — une seule page, un seul défilement.' },
      { mark: 'memory', text:
        'Mémoire montre ce que l’agent a appris de vous — consultable et entièrement modifiable.' },
      { mark: 'automations', text:
        'Automatisations exécute des tâches planifiées et des déclencheurs sans surveillance — voici le bulletin de nouvelles du matin, exécuté à l’heure prévue.' },
      { mark: 'products', text:
        'Et les fichiers produits par ces exécutions arrivent dans Produits, conservés sur l’appareil et prêts à télécharger.' },
    ],
    },
  },
  {
    id: 'documents',
    title: 'Documents out',
    action: 'Asks for a three-slide deck on the article; a .pptx download card appears in the chat.',
    beats: {
    en: [
      { mark: 'start', text: 'The agent produces real files, not just chat.' },
      { mark: 'asked', text: 'Ask for a three-slide deck on this article…' },
      {
        mark: 'card',
        text:
          '…and a PowerPoint is built on-device — titles, bullets, and a speaker note — delivered as a download card right in the conversation.',
      },
    ],
    fr: [
      { mark: 'start', text:
        'L’agent produit de vrais fichiers, pas seulement du texte.' },
      { mark: 'asked', text:
        'Demandez un jeu de trois diapositives sur cet article…' },
      { mark: 'card', text:
        '…et une présentation PowerPoint est construite sur l’appareil — titres, puces, et note d’allocution — livrée comme carte de téléchargement dans la conversation.' },
    ],
    },
  },
  {
    id: 'resilience',
    title: 'Built for imperfect networks',
    action: 'A request against a rate-limited endpoint: retrying notice, then a clean recovered answer.',
    beats: {
    en: [
      { mark: 'start', text: 'One more thing: failure handling. This request is about to hit a rate-limited endpoint.' },
      { mark: 'retrying', text: 'The agent reads the server’s retry hint, backs off, and says so — right in the conversation.' },
      { mark: 'answered', text: 'Then it recovers to a clean answer on its own. No babysitting.' },
    ],
    fr: [
      { mark: 'start', text:
        'Une dernière chose : la gestion des pannes. Cette requête va frapper un point de terminaison saturé.' },
      { mark: 'retrying', text:
        'L’agent lit l’indication de réessai du serveur, patiente, et le dit — directement dans la conversation.' },
      { mark: 'answered', text:
        'Puis il se rétablit tout seul, avec une réponse propre. Aucune surveillance requise.' },
    ],
    },
  },
  {
    id: 'outro',
    title: 'Wrap-up',
    action: 'Outro card with the project location.',
    beats: {
    en: [
      {
        mark: 'start',
        text:
          'That’s CANChat Agent: your browser, your session, your data — with an agent that shows its plan, logs its tools, and asks before it acts. Load the extension, connect a model, and try it on your own tabs.',
      },
    ],
    fr: [
      { mark: 'start', text:
        'Voilà CANChat Agent : votre navigateur, votre session, vos données — avec un agent qui montre son plan, journalise ses outils, et demande avant d’agir. Chargez l’extension, connectez un modèle, et essayez-le sur vos propres onglets.' },
    ],
    },
  },
];
