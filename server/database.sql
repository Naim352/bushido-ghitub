-- ══════════════════════════════════════════════
-- BUSHIDO STORE — Création des tables
-- Exécute ce fichier UNE SEULE FOIS sur Railway
-- ══════════════════════════════════════════════

-- Table des clients (remplace les faux CUSTOMERS)
CREATE TABLE IF NOT EXISTS clients (
  id          SERIAL PRIMARY KEY,
  prenom      VARCHAR(100) NOT NULL,
  nom         VARCHAR(100) NOT NULL,
  email       VARCHAR(255) UNIQUE NOT NULL,
  mot_de_passe VARCHAR(255) NOT NULL,  -- hashé avec bcrypt
  discipline  VARCHAR(100),
  telephone   VARCHAR(20),
  adresse     VARCHAR(255),
  code_postal VARCHAR(10),
  ville       VARCHAR(100),
  avatar      VARCHAR(10) DEFAULT '🥋',
  points      INTEGER DEFAULT 0,
  total_depense DECIMAL(10,2) DEFAULT 0,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- Table des commandes
CREATE TABLE IF NOT EXISTS commandes (
  id              SERIAL PRIMARY KEY,
  client_id       INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  stripe_id       VARCHAR(255),          -- ID du PaymentIntent Stripe
  montant         DECIMAL(10,2) NOT NULL,
  articles        TEXT,                  -- JSON des articles
  statut          VARCHAR(50) DEFAULT 'En traitement',
  created_at      TIMESTAMP DEFAULT NOW()
);

-- Index pour les recherches rapides
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
CREATE INDEX IF NOT EXISTS idx_commandes_client ON commandes(client_id);
CREATE INDEX IF NOT EXISTS idx_commandes_stripe ON commandes(stripe_id);
