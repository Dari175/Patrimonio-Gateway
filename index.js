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

  ip: String,
  dispositivo: String,
  navegador: String,

  recursoId: String,

  fecha: { type: Date, default: Date.now }
}));

// =============================
// MIDDLEWARES BASE
// =============================
app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());

app.use((req, res, next) => {
  console.log(`[GATEWAY] ${req.method} ${req.url}`);
  next();
});

// =============================
// 🧠 HELPERS
// =============================
function extraerUsuario(req) {
  // 🔥 LOGIN (no hay token aún)
  if (req.originalUrl.includes('/login')) {
    return {
      usuario: null,
      email: req.body?.email || null
    };
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { usuario: null, email: null };
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.decode(token);

    return {
      usuario: decoded?.sub || null,
      email: decoded?.email || null
    };
  } catch {
    return { usuario: null, email: null };
  }
}

function mapAction(req, status) {
  if (req.originalUrl.includes('/login')) {
    return status === 200 ? 'LOGIN_SUCCESS' : 'LOGIN_FAIL';
  }

  if (req.originalUrl.includes('/logout')) return 'LOGOUT';

  switch (req.method) {
    case 'POST': return 'CREAR';
    case 'PUT':
    case 'PATCH': return 'EDITAR';
    case 'DELETE': return 'ELIMINAR';
    default: return 'OTRO';
  }
}

function getRealIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.socket?.remoteAddress ||
    req.ip ||
    null
  );
}

function parseUserAgent(ua = '') {
  ua = ua.toLowerCase();

  let dispositivo = 'DESKTOP';
  if (ua.includes('mobile')) dispositivo = 'MOBILE';
  if (ua.includes('tablet')) dispositivo = 'TABLET';

  let navegador = 'OTRO';
  if (ua.includes('chrome')) navegador = 'CHROME';
  else if (ua.includes('firefox')) navegador = 'FIREFOX';
  else if (ua.includes('safari')) navegador = 'SAFARI';
  else if (ua.includes('edge')) navegador = 'EDGE';

  return { dispositivo, navegador };
}

function getRecursoId(req) {
  const match = req.originalUrl.match(/\/([a-f0-9]{24})/);
  return match ? match[1] : null;
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
// 🔥 ENDPOINT HISTORIAL
// =============================
app.get('/historial', async (req, res) => {
  try {
    const { usuario, modulo, pagina = 1, limite = 20 } = req.query;

    const filtro = {};
    if (usuario) filtro.usuario = usuario;
    if (modulo) filtro.modulo = modulo;

    const skip = (pagina - 1) * limite;

    const [total, logs] = await Promise.all([
      Historial.countDocuments(filtro),
      Historial.find(filtro)
        .sort({ fecha: -1 })
        .skip(skip)
        .limit(parseInt(limite))
    ]);

    res.json({
      ok: true,
      total,
      pagina: parseInt(pagina),
      limite: parseInt(limite),
      historial: logs
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, mensaje: 'Error obteniendo historial' });
  }
});

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

  } catch {
    return res.status(502).json({ error: 'Error en login' });
  }
});

// =============================
// 🔥 PROXY + HISTORIAL
// =============================
const createSafeProxy = (config) => {
  return createProxyMiddleware({
    ...config,
    proxyTimeout: 20000,
    timeout: 20000,

    onProxyRes: (proxyRes, req) => {
      try {
        if (req.method === 'GET') return;

        const { usuario, email } = extraerUsuario(req);

        const modulo =
          req.headers['x-module'] ||
          (req.originalUrl.startsWith('/auth') ? 'auth' : 'unknown');

        const ua = req.headers['user-agent'] || '';
        const { dispositivo, navegador } = parseUserAgent(ua);

        setImmediate(() => {
          Historial.create({
            usuario,
            email,
            modulo,
            metodo: req.method,
            ruta: req.originalUrl,
            accion: mapAction(req, proxyRes.statusCode),
            status: proxyRes.statusCode,

            ip: getRealIP(req),
            dispositivo,
            navegador,

            recursoId: getRecursoId(req)
          }).catch(err => {
            console.log('Error historial:', err.message);
          });
        });

      } catch (err) {
        console.log('Error historial proxy:', err.message);
      }
    },

    onError: async (err, req, res) => {
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