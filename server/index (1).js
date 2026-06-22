require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY, {
  maxNetworkRetries: 3,
  timeout: 20000,
});

const app  = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════════
// EMAIL — Notifications (Gmail SMTP)
// ══════════════════════════════════════════════
const mailer = (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    })
  : null;

async function sendMail(to, subject, html) {
  if (!mailer) {
    console.warn('⚠️  Email non envoyé (GMAIL_USER / GMAIL_APP_PASSWORD manquants) :', subject);
    return;
  }
  try {
    await mailer.sendMail({ from: `"Bushido Store" <${process.env.GMAIL_USER}>`, to, subject, html });
  } catch (err) {
    console.error('Erreur envoi email:', err.message);
  }
}

function lienCompte() {
  return `${process.env.FRONTEND_URL || ''}/#mon-compte`;
}

// ══════════════════════════════════════════════
// BASE DE DONNÉES — Connexion Railway OU local
// ══════════════════════════════════════════════
let db;

if (process.env.DATABASE_URL) {
  // ✅ Railway (ou toute DATABASE_URL fournie) — avec SSL
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  console.log('🔗 Connexion DB via DATABASE_URL (Railway)');
} else {
  // ✅ Local — sans SSL, via 127.0.0.1 pour éviter ECONNREFUSED ::1
  db = new Pool({
    host:     process.env.DB_HOST     || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'bushido_store',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl:      false
  });
  console.log('🔗 Connexion DB locale (127.0.0.1:5432)');
}

// Crée automatiquement les tables au démarrage
async function setupDatabase() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id          SERIAL PRIMARY KEY,
        prenom      VARCHAR(100) NOT NULL,
        nom         VARCHAR(100) NOT NULL,
        email       VARCHAR(255) UNIQUE NOT NULL,
        mot_de_passe VARCHAR(255) NOT NULL,
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
      CREATE TABLE IF NOT EXISTS commandes (
        id              SERIAL PRIMARY KEY,
        client_id       INTEGER REFERENCES clients(id) ON DELETE CASCADE,
        stripe_id       VARCHAR(255),
        montant         DECIMAL(10,2) NOT NULL,
        articles        TEXT,
        statut          VARCHAR(50) DEFAULT 'En traitement',
        created_at      TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
      CREATE INDEX IF NOT EXISTS idx_commandes_client ON commandes(client_id);
      CREATE INDEX IF NOT EXISTS idx_commandes_stripe ON commandes(stripe_id);
    `);
    console.log('✅ Tables vérifiées/créées avec succès');
  } catch (err) {
    console.error('❌ Erreur création des tables :', err.message);
  }
}

// ══════════════════════════════════════════════
// MIDDLEWARES
// ══════════════════════════════════════════════
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

function authRequired(req, res, next) {
  const header = req.headers['authorization'];
  const token  = header && header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Connexion requise' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée, reconnectez-vous' });
  }
}

// ══════════════════════════════════════════════
// AUTH — INSCRIPTION
// ══════════════════════════════════════════════
app.post('/api/auth/inscription', async (req, res) => {
  const { prenom, nom, email, mot_de_passe, discipline } = req.body;

  if (!prenom || !nom || !email || !mot_de_passe)
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  if (mot_de_passe.length < 8)
    return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum' });

  try {
    const exist = await db.query('SELECT id FROM clients WHERE email=$1', [email.toLowerCase()]);
    if (exist.rows.length > 0)
      return res.status(409).json({ error: 'Cet email est déjà utilisé' });

    const hash = await bcrypt.hash(mot_de_passe, 12);

    const result = await db.query(
      `INSERT INTO clients (prenom, nom, email, mot_de_passe, discipline)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, prenom, nom, email, discipline, points, total_depense, created_at`,
      [prenom, nom, email.toLowerCase(), hash, discipline || null]
    );

    const client = result.rows[0];
    const token  = jwt.sign({ id: client.id, email: client.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    if (process.env.ADMIN_EMAIL) {
      sendMail(
        process.env.ADMIN_EMAIL,
        `🆕 Nouveau client : ${client.prenom} ${client.nom}`,
        `<h2>Nouvelle inscription</h2>
         <p><b>Nom :</b> ${client.prenom} ${client.nom}</p>
         <p><b>Email :</b> ${client.email}</p>
         <p><b>Discipline :</b> ${client.discipline || '—'}</p>
         <p><b>Date :</b> ${new Date(client.created_at).toLocaleString('fr-FR')}</p>`
      );
    }

    sendMail(
      client.email,
      `Bienvenue chez Bushido Store, ${client.prenom} 🥋`,
      `<h2>Bienvenue ${client.prenom} !</h2>
       <p>Ton compte Bushido Store a bien été créé.</p>
       <p>Accède à ton espace personnel (commandes, points, profil) ici :</p>
       <p><a href="${lienCompte()}">${lienCompte()}</a></p>`
    );

    res.json({ token, client });

  } catch (err) {
    console.error('Inscription error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════
// AUTH — CONNEXION
// ══════════════════════════════════════════════
app.post('/api/auth/connexion', async (req, res) => {
  const { email, mot_de_passe } = req.body;
  if (!email || !mot_de_passe)
    return res.status(400).json({ error: 'Email et mot de passe requis' });

  try {
    const result = await db.query('SELECT * FROM clients WHERE email=$1', [email.toLowerCase()]);
    const client = result.rows[0];

    if (!client || !(await bcrypt.compare(mot_de_passe, client.mot_de_passe)))
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    delete client.mot_de_passe;

    const orders = await db.query(
      'SELECT * FROM commandes WHERE client_id=$1 ORDER BY created_at DESC',
      [client.id]
    );
    client.commandes = orders.rows;

    const token = jwt.sign({ id: client.id, email: client.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.json({ token, client });

  } catch (err) {
    console.error('Connexion error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════
// PROFIL — Voir / Modifier
// ══════════════════════════════════════════════
app.get('/api/profil', authRequired, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, prenom, nom, email, discipline, telephone, adresse, code_postal, ville, avatar, points, total_depense, created_at FROM clients WHERE id=$1',
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Client introuvable' });

    const orders = await db.query(
      'SELECT * FROM commandes WHERE client_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );

    const client = result.rows[0];
    client.commandes = orders.rows;
    res.json(client);

  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.put('/api/profil', authRequired, async (req, res) => {
  const { prenom, nom, telephone, adresse, code_postal, ville, discipline } = req.body;
  try {
    const result = await db.query(
      `UPDATE clients SET prenom=$1, nom=$2, telephone=$3, adresse=$4, code_postal=$5, ville=$6, discipline=$7
       WHERE id=$8
       RETURNING id, prenom, nom, email, discipline, telephone, adresse, code_postal, ville, avatar, points, total_depense`,
      [prenom, nom, telephone, adresse, code_postal, ville, discipline, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════
// STRIPE — Créer un Payment Intent
// ══════════════════════════════════════════════
app.post('/api/create-payment-intent', async (req, res) => {
  const { amount, currency = 'eur', email, name } = req.body;

  if (!amount || amount < 50)
    return res.status(400).json({ error: 'Montant invalide (minimum 0,50 €)' });
  if (!email)
    return res.status(400).json({ error: 'Email requis' });

  try {
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    customer = existing.data.length > 0
      ? existing.data[0]
      : await stripe.customers.create({ email, name });

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      customer: customer.id,
      receipt_email: email,
      metadata: { email, name: name || '', source: 'bushido-store' },
      automatic_payment_methods: { enabled: true },
    });

    res.json({ clientSecret: paymentIntent.client_secret });

  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
// STRIPE — Webhook (paiement confirmé)
// ══════════════════════════════════════════════
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi    = event.data.object;
    const email = pi.receipt_email || pi.metadata?.email;
    const name  = pi.metadata?.name || '';
    const amount = pi.amount / 100;

    if (email) {
      try {
        const result = await db.query('SELECT id, prenom, nom FROM clients WHERE email=$1', [email.toLowerCase()]);
        if (result.rows.length > 0) {
          const clientId = result.rows[0].id;

          await db.query(
            `INSERT INTO commandes (client_id, stripe_id, montant, articles, statut)
             VALUES ($1, $2, $3, $4, 'En traitement')`,
            [clientId, pi.id, amount, pi.metadata?.articles || '']
          );

          await db.query(
            `UPDATE clients SET total_depense = total_depense + $1, points = FLOOR(total_depense + $1)
             WHERE id = $2`,
            [amount, clientId]
          );

          if (process.env.ADMIN_EMAIL) {
            const nomClient = result.rows[0].prenom ? `${result.rows[0].prenom} ${result.rows[0].nom}` : email;
            sendMail(
              process.env.ADMIN_EMAIL,
              `💰 Paiement reçu : ${amount.toFixed(2)} € — ${nomClient}`,
              `<h2>Nouveau paiement confirmé</h2>
               <p><b>Client :</b> ${nomClient} (${email})</p>
               <p><b>Montant :</b> ${amount.toFixed(2)} €</p>
               <p><b>Référence Stripe :</b> ${pi.id}</p>
               <p><b>Date :</b> ${new Date().toLocaleString('fr-FR')}</p>`
            );
          }
        }
      } catch (dbErr) {
        console.error('DB webhook error:', dbErr.message);
      }
    }
  }

  res.json({ received: true });
});

// ══════════════════════════════════════════════
// ADMIN — Base clients
// ══════════════════════════════════════════════
app.get('/api/admin/clients', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_PASSWORD)
    return res.status(403).json({ error: 'Accès interdit' });

  try {
    const result = await db.query(`
      SELECT
        c.id, c.prenom, c.nom, c.email, c.discipline,
        c.points, c.total_depense, c.avatar, c.created_at,
        COUNT(o.id) AS nb_commandes,
        MAX(o.created_at) AS dernier_achat
      FROM clients c
      LEFT JOIN commandes o ON o.client_id = c.id
      GROUP BY c.id
      ORDER BY c.total_depense DESC
    `);

    const totalCA = result.rows.reduce((s, c) => s + parseFloat(c.total_depense), 0);
    const vips    = result.rows.filter(c => parseFloat(c.total_depense) > 500).length;

    res.json({
      clients: result.rows,
      stats: {
        total: result.rows.length,
        vips,
        chiffre_affaires: totalCA.toFixed(2),
        panier_moyen: result.rows.length > 0
          ? (totalCA / result.rows.reduce((s, c) => s + parseInt(c.nb_commandes || 0), 0) || 0).toFixed(2)
          : '0',
      }
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
// SANTÉ DU SERVEUR
// ══════════════════════════════════════════════
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date() }));

app.get('/api/diagnostic', (_req, res) => {
  res.json({
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? `présente (commence par ${process.env.STRIPE_SECRET_KEY.slice(0,8)})` : '❌ MANQUANTE',
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ? `présente (commence par ${process.env.STRIPE_WEBHOOK_SECRET.slice(0,8)})` : '❌ MANQUANTE',
    DATABASE_URL: process.env.DATABASE_URL ? '✅ présente' : '❌ MANQUANTE — mode local actif',
    JWT_SECRET: process.env.JWT_SECRET ? '✅ présente' : '❌ MANQUANTE',
    FRONTEND_URL: process.env.FRONTEND_URL || '❌ MANQUANTE',
    ADMIN_EMAIL: process.env.ADMIN_EMAIL || '❌ MANQUANTE',
    GMAIL_USER: process.env.GMAIL_USER || '❌ MANQUANTE',
    GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD ? '✅ présente' : '❌ MANQUANTE',
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ══════════════════════════════════════════════
// DÉMARRAGE
// ══════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log(`\n🥋 Bushido Server → http://localhost:${PORT}`);
  console.log(`   Stripe  : ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_') ? '✅ OK' : '❌ MANQUANT'}`);
  console.log(`   DB      : ${process.env.DATABASE_URL ? '✅ Railway' : '🏠 Local 127.0.0.1'}`);
  console.log(`   JWT     : ${process.env.JWT_SECRET ? '✅ OK' : '❌ MANQUANT'}\n`);
  await setupDatabase();
});
