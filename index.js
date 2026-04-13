const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// =============================
// 🔥 MONGO
// =============================
mongoose.connect(
  'mongodb+srv://patrimonioatotonilcoti_db_user:<db_password>@cluster0.01itri5.mongodb.net/patrimonio'
).then(() => {
  console.log('✅ Mongo conectado (historial)');
}).catch(err => {
  console.error('❌ Error Mongo:', err.message);
});

// =============================
// 🔥 MODELO HISTORIAL
// =============================
const HistorialSchema = new mongoose.Schema({
  usuario: String,
  email: String,
  modulo: String,
  metodo: String,
  ruta: String,
  accion: String,
  status: Number,
  ip: String,
  userAgent: String,
  fecha: { type: Date, default: Date.now }
}, { versionKey: false });

HistorialSchema.index({ usuario: 1, fecha: -1 });
HistorialSchema.index({ modulo: 1 });

const Historial = mongoose.model('Historial', HistorialSchema);

// =============================
// MIDDLEWARES
// =============================
app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());

// =============================
// 🔥 HISTORIAL (NO BLOQUEANTE)
// =============================
app.use((req, res, next) => {
  const originalSend = res.send;

  res.send = function (body) {
    try {
      // 🔹 usuario desde JWT
      let usuario = null;
      let email = null;

      const authHeader = req.headers.authorization;

      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.split(' ')[1];
          const decoded = jwt.decode(token);

          usuario = decoded?.sub || null;
          email = decoded?.email || null;

        } catch (e) {}
      }

      const modulo =
        req.headers['x-module'] ||
        (req.originalUrl.startsWith('/auth') ? 'auth' : 'unknown');

      // 🔥 SOLO acciones importantes
      if (req.method !== 'GET') {
        // 🚀 BACKGROUND (NO BLOQUEA)
        setImmediate(() => {
          Historial.create({
            usuario,
            email,
            modulo,
            metodo: req.method,
            ruta: req.originalUrl,
            accion: mapAction(req),
            status: res.statusCode,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
            fecha: new Date()
          }).catch(err => {
            console.log('Error historial:', err.message);
          });
        });
      }

    } catch (err) {
      console.log('Error historial middleware:', err.message);
    }

    return originalSend.call(this, body);
  };

  next();
});

// =============================
// 🧠 MAP ACTION
// =============================
function mapAction(req) {
  if (req.originalUrl.includes('/login')) return 'LOGIN';
  if (req.originalUrl.includes('/logout')) return 'LOGOUT';

  switch (req.method) {
    case 'POST': return 'CREAR';
    case 'PUT':
    case 'PATCH': return 'EDITAR';
    case 'DELETE': return 'ELIMINAR';
    default: return 'OTRO';
  }
}

// =============================
// 🔥 ENDPOINT HISTORIAL
// =============================
app.get('/historial', async (req, res) => {
  try {
    const {
      usuario,
      modulo,
      pagina = 1,
      limite = 20
    } = req.query;

    const filtro = {};

    if (usuario) filtro.usuario = usuario;
    if (modulo) filtro.modulo = modulo;

    const skip = (parseInt(pagina) - 1) * parseInt(limite);

    const [total, logs] = await Promise.all([
      Historial.countDocuments(filtro),
      Historial.find(filtro)
        .sort({ fecha: -1 })
        .skip(skip)
        .limit(parseInt(limite))
    ]);

    return res.json({
      total,
      pagina: parseInt(pagina),
      limite: parseInt(limite),
      historial: logs
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error obteniendo historial' });
  }
});

// =============================
// LOGGER
// =============================
app.use((req, res, next) => {
  console.log(`[GATEWAY] ${req.method} ${req.url}`);
  next();
});

// =============================
// SERVICIOS
// =============================
const SERVICES = {
  auth: 'https://patrimonio-apiservice-auth.onrender.com',
  upload: 'https://patrimonio-loadimages.onrender.com',
  bienes: 'https://bienes-service-nldc.onrender.com',
  importador: 'https://patrimonio-importexeldb.onrender.com'
};

// =============================
// WAKE-UP
// =============================
const wakeServiceIfNeeded = async (baseUrl) => {
  try {
    await fetch(baseUrl + '/health');
  } catch {
    await fetch(baseUrl + '/health').catch(() => null);
    await new Promise(r => setTimeout(r, 4000));
    await fetch(baseUrl + '/health').catch(() => null);
  }
};

// =============================
// LOGIN
// =============================
app.post('/auth/login', async (req, res) => {
  try {
    await wakeServiceIfNeeded(SERVICES.auth);

    const response = await fetch(SERVICES.auth + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    return res.status(response.status).json(data);

  } catch (error) {
    if (res.headersSent) return;
    return res.status(502).json({ error: 'Error en login' });
  }
});

// =============================
// PROXY BASE
// =============================
const createSafeProxy = (config) => {
  return createProxyMiddleware({
    ...config,
    proxyTimeout: 20000,
    timeout: 20000
  });
};

// =============================
// AUTH
// =============================
app.use('/auth',
  async (req, res, next) => {
    await wakeServiceIfNeeded(SERVICES.auth);
    next();
  },
  createSafeProxy({
    target: SERVICES.auth,
    changeOrigin: true,
    pathRewrite: { '^/auth': '/' }
  })
);

// =============================
// ROLES
// =============================
app.use('/roles',
  async (req, res, next) => {
    req.headers['x-module'] = 'roles';
    await wakeServiceIfNeeded(SERVICES.auth);
    next();
  },
  createSafeProxy({
    target: SERVICES.auth,
    changeOrigin: true,
    pathRewrite: { '^/roles': '/' }
  })
);

// =============================
// USUARIOS
// =============================
app.use('/usuarios',
  async (req, res, next) => {
    req.headers['x-module'] = 'usuarios';
    await wakeServiceIfNeeded(SERVICES.auth);
    next();
  },
  createSafeProxy({
    target: SERVICES.auth,
    changeOrigin: true,
    pathRewrite: { '^/usuarios': '/' }
  })
);

// =============================
// UPLOAD
// =============================
app.use('/api/upload',
  async (req, res, next) => {
    await wakeServiceIfNeeded(SERVICES.upload);
    next();
  },
  createSafeProxy({
    target: SERVICES.upload,
    changeOrigin: true,
    pathRewrite: (path) => '/api/upload' + path
  })
);

// =============================
// BIENES
// =============================
app.use('/bienes',
  async (req, res, next) => {
    await wakeServiceIfNeeded(SERVICES.bienes);
    next();
  },
  createSafeProxy({
    target: SERVICES.bienes,
    changeOrigin: true,
    pathRewrite: (path) => '/api' + path
  })
);

// =============================
// IMPORTADOR
// =============================
app.use('/importador',
  async (req, res, next) => {
    await wakeServiceIfNeeded(SERVICES.importador);
    next();
  },
  createSafeProxy({
    target: SERVICES.importador + '/importar',
    changeOrigin: true,
    pathRewrite: { '^/importador': '' }
  })
);

// =============================
// HEALTH
// =============================
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// =============================
app.listen(PORT, () => {
  console.log(`🚀 Gateway corriendo en puerto ${PORT}`);
});