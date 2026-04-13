const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// =============================
// 🔥 MONGO (historial)
// =============================
mongoose.connect(
  'mongodb+srv://patrimonioatotonilcoti_db_user:Patrimonio!123@cluster0.01itri5.mongodb.net/PatrimonioDB?appName=Cluster0'
).then(() => {
  console.log('✅ Mongo conectado (historial)');
}).catch(err => {
  console.error('❌ Error Mongo:', err.message);
});

// =============================
// 🔥 MODELO HISTORIAL
// =============================
const Historial = mongoose.model('Historial', new mongoose.Schema({
  usuario: String,
  email: String,
  modulo: String,
  metodo: String,
  ruta: String,
  accion: String,
  status: Number,
  fecha: { type: Date, default: Date.now }
}));

// =============================
// MIDDLEWARES BASE
// =============================
app.use(cors({
  origin: true,
  credentials: true
}));

app.use((req, res, next) => {
  console.log(`[GATEWAY] ${req.method} ${req.url}`);
  next();
});

// =============================
// 🧠 HELPERS
// =============================
function extraerUsuario(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {};
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.decode(token);

    return {
      usuario: decoded?.sub || null,
      email: decoded?.email || null
    };
  } catch {
    return {};
  }
}

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
// CONFIG SERVICIOS
// =============================
const SERVICES = {
  auth: 'https://patrimonio-apiservice-auth.onrender.com',
  upload: 'https://patrimonio-loadimages.onrender.com',
  bienes: 'https://bienes-service-nldc.onrender.com',
  importador: 'https://patrimonio-importexeldb.onrender.com'
};

// =============================
// WAKE-UP INTELIGENTE
// =============================
const wakeServiceIfNeeded = async (baseUrl) => {
  try {
    console.log('[WAKE] Ping:', baseUrl);
    await fetch(baseUrl + '/health');
  } catch (err) {
    console.log('[WAKE] Servicio dormido, despertando:', baseUrl);

    await fetch(baseUrl + '/health').catch(() => null);
    await new Promise(resolve => setTimeout(resolve, 4000));
    await fetch(baseUrl + '/health').catch(() => null);
  }
};

// =============================
// LOGIN MANUAL
// =============================
app.post('/auth/login', express.json(), async (req, res) => {
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
// 🔥 PROXY SEGURO + HISTORIAL
// =============================
const createSafeProxy = (config) => {
  return createProxyMiddleware({
    ...config,
    proxyTimeout: 20000,
    timeout: 20000,

    // 🔥 HISTORIAL CORRECTO
    onProxyRes: (proxyRes, req, res) => {
      try {
        if (req.method === 'GET') return;

        const { usuario, email } = extraerUsuario(req);

        const modulo =
          req.headers['x-module'] ||
          (req.originalUrl.startsWith('/auth') ? 'auth' : 'unknown');

        setImmediate(() => {
          Historial.create({
            usuario,
            email,
            modulo,
            metodo: req.method,
            ruta: req.originalUrl,
            accion: mapAction(req),
            status: proxyRes.statusCode
          }).catch(err => {
            console.log('Error historial:', err.message);
          });
        });

      } catch (err) {
        console.log('Error historial proxy:', err.message);
      }
    },

    // 🔥 TU RECOVERY ORIGINAL
    onError: async (err, req, res) => {
      console.log('[PROXY ERROR]', err.code);

      if (res.headersSent) return;

      if (req.method === 'GET') {
        return res.status(502).json({
          error: 'Servicio temporalmente no disponible'
        });
      }

      try {
        const target = config.target;

        await wakeServiceIfNeeded(target);

        let rewrittenPath = req.originalUrl;

        if (req.originalUrl.startsWith('/auth')) {
          rewrittenPath = req.originalUrl.replace('/auth', '');
        } else if (req.originalUrl.startsWith('/roles')) {
          rewrittenPath = req.originalUrl.replace('/roles', '');
        } else if (req.originalUrl.startsWith('/usuarios')) {
          rewrittenPath = req.originalUrl.replace('/usuarios', '');
        } else if (req.originalUrl.startsWith('/importador')) {
          rewrittenPath = req.originalUrl.replace('/importador', '');
        }

        if (!rewrittenPath.startsWith('/')) {
          rewrittenPath = '/' + rewrittenPath;
        }

        const retryRes = await fetch(target + rewrittenPath, {
          method: req.method,
          headers: {
            'Content-Type': 'application/json',
            ...(req.headers.authorization && {
              Authorization: req.headers.authorization
            })
          },
          body: ['GET', 'HEAD'].includes(req.method)
            ? undefined
            : JSON.stringify(req.body)
        });

        const data = await retryRes.text();

        res.removeHeader('content-length');
        res.status(retryRes.status).send(data);

      } catch {
        if (!res.headersSent) {
          res.status(502).json({
            error: 'Servicio temporalmente no disponible'
          });
        }
      }
    }
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
    pathRewrite: { '^/usuarios': '/' },

    onProxyReq: (proxyReq, req) => {
      proxyReq.setHeader('x-module', 'usuarios');

      if (req.headers.authorization) {
        proxyReq.setHeader('Authorization', req.headers.authorization);
      }

      if (req.body && Object.keys(req.body).length) {
        const bodyData = JSON.stringify(req.body);

        proxyReq.setHeader('Content-Type', 'application/json');
        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));

        proxyReq.write(bodyData);
      }
    }
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
  createProxyMiddleware({
    target: SERVICES.bienes,
    changeOrigin: true,
    pathRewrite: (path) => '/api' + path,
    proxyTimeout: 20000,
    timeout: 20000
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