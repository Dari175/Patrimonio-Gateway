const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json()); 
app.use(cors({
  origin: true,
  credentials: true
}));

app.use((req, res, next) => {
  console.log(`[GATEWAY] ${req.method} ${req.url}`);
  next();
});


// =============================
// CONFIGURACION GLOBAL
// =============================
const SERVICES = {
  auth: 'https://patrimonio-apiservice-auth.onrender.com',
  upload: 'https://patrimonio-loadimages.onrender.com',
  bienes: 'https://bienes-service-nldc.onrender.com',
  importador: 'https://patrimonio-importexeldb.onrender.com'
};

let servicesWarmed = false;
let lastWarmTime = 0;


// =============================
// FUNCION DE WARM-UP
// =============================
const warmUpServices = async () => {
  console.log('[WARMUP] Iniciando calentamiento de servicios');

  await Promise.allSettled(
    Object.values(SERVICES).map(url =>
      fetch(`${url}/health`).catch(() => null)
    )
  );

  console.log('[WARMUP] Servicios despertados');
};


// =============================
// RETRY INTELIGENTE
// =============================
const retryRequest = async (url, options, retries = 1) => {
  try {
    return await fetch(url, options);
  } catch (err) {
    if (retries <= 0) throw err;

    console.log('[RETRY] Intentando despertar servicio:', url);

    try {
      await fetch(url.replace(/\/[^/]+$/, '/health'));
    } catch (_) {}

    return retryRequest(url, options, retries - 1);
  }
};


// =============================
// MIDDLEWARE GLOBAL WARM-UP
// =============================
app.use(async (req, res, next) => {
  const now = Date.now();

  if (!servicesWarmed || now - lastWarmTime > 5 * 60 * 1000) {
    servicesWarmed = true;
    lastWarmTime = now;

    await warmUpServices();
  }

  next();
});


// =============================
// 🔥 LOGIN MANUAL (FIX CLAVE)
// =============================
app.post('/auth/login', async (req, res) => {
  try {
    const url = SERVICES.auth + '/login';

    let response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(req.headers.authorization && {
            Authorization: req.headers.authorization
          })
        },
        body: JSON.stringify(req.body)
      });
    } catch (err) {
      console.log('[LOGIN RETRY] Servicio dormido, despertando...');

      await fetch(SERVICES.auth + '/health').catch(() => null);

      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(req.headers.authorization && {
            Authorization: req.headers.authorization
          })
        },
        body: JSON.stringify(req.body)
      });
    }

    const data = await response.text();

    res.status(response.status).send(data);

  } catch (error) {
    res.status(502).json({
      error: 'Error en login'
    });
  }
});


// =============================
// PROXY CON MANEJO DE ERROR
// =============================
const createSafeProxy = (config) => {
  return createProxyMiddleware({
    ...config,
    proxyTimeout: 20000,
    timeout: 20000,

    onError: async (err, req, res) => {
      console.log('[PROXY ERROR]', err.code);

      if (res.headersSent) return;

      try {
        const target = config.target;

        console.log('[RECOVERY] Despertando servicio:', target);

        await fetch(`${target}/health`).catch(() => null);

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

        const retryUrl = target + rewrittenPath;

        const retryRes = await retryRequest(retryUrl, {
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

      } catch (retryErr) {
        console.log('[FATAL] No se pudo recuperar el servicio');

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
// AUTH SERVICE (NO SE TOCA)
// =============================
app.use('/auth', createSafeProxy({
  target: SERVICES.auth,
  changeOrigin: true,
  pathRewrite: {
    '^/auth': '/'
  },
  onProxyReq: (proxyReq, req) => {
    proxyReq.setHeader('ngrok-skip-browser-warning', 'true');

    if (req.headers.authorization) {
      proxyReq.setHeader('Authorization', req.headers.authorization);
    }
  }
}));


// =============================
// ROLES
// =============================
app.use('/roles',
  (req, res, next) => {
    req.headers['x-module'] = 'roles';
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
  (req, res, next) => {
    req.headers['x-module'] = 'usuarios';
    next();
  },
  createSafeProxy({
    target: SERVICES.auth,
    changeOrigin: true,
    pathRewrite: { '^/usuarios': '/' }
  })
);


// =============================
// UPLOAD SERVICE
// =============================
app.use('/api/upload', createSafeProxy({
  target: SERVICES.upload,
  changeOrigin: true,
  pathRewrite: (path) => '/api/upload' + path,
  onProxyReq: (proxyReq, req) => {
    proxyReq.setHeader('ngrok-skip-browser-warning', 'true');

    if (req.headers.authorization) {
      proxyReq.setHeader('Authorization', req.headers.authorization);
    }

    proxyReq.setHeader('x-module', 'roles');
  }
}));


// =============================
// BIENES SERVICE
// =============================
app.use('/bienes', createSafeProxy({
  target: SERVICES.bienes,
  changeOrigin: true,
  pathRewrite: (path) => '/api' + path,
  onProxyReq: (proxyReq, req) => {
    proxyReq.setHeader('ngrok-skip-browser-warning', 'true');

    if (req.headers.authorization) {
      proxyReq.setHeader('Authorization', req.headers.authorization);
    }
  }
}));


// =============================
// HEALTH
// =============================
app.get('/health', (req, res) => {
  res.json({ ok: true });
});


// =============================
// IMPORTADOR SERVICE
// =============================
app.use('/importador', createSafeProxy({
  target: SERVICES.importador + '/importar',
  changeOrigin: true,
  pathRewrite: {
    '^/importador': ''
  },
  onProxyReq: (proxyReq, req) => {
    proxyReq.setHeader('ngrok-skip-browser-warning', 'true');

    if (req.headers.authorization) {
      proxyReq.setHeader('Authorization', req.headers.authorization);
    }

    proxyReq.setHeader('x-module', 'importador');
  }
}));

app.use('/importador', (req, res, next) => {
  console.log("PATH ORIGINAL:", req.url);
  next();
});


app.listen(PORT, () => {
  console.log(`Gateway corriendo en puerto ${PORT}`);
});