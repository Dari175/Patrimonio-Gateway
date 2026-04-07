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


// =============================
// LOGIN MANUAL (CONTROL TOTAL)
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

      // despertar solo si falla
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

    const data = await response.json();
    res.status(response.status).json(data);

  } catch (error) {
    res.status(502).json({
      error: 'Error en login'
    });
  }
});


// =============================
// PROXY SEGURO (SIN MULTIPLICAR REQUESTS)
// =============================
const createSafeProxy = (config) => {
  return createProxyMiddleware({
    ...config,
    proxyTimeout: 20000,
    timeout: 20000,

    onError: async (err, req, res) => {
      console.log('[PROXY ERROR]', err.code);

      if (res.headersSent) return;

      // 🔥 IMPORTANTE:
      // NO hacer retry en GET (evita 429)
      if (req.method === 'GET') {
        return res.status(502).json({
          error: 'Servicio temporalmente no disponible'
        });
      }

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

        const retryRes = await fetch(retryUrl, {
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
// AUTH SERVICE
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
// BIENES SERVICE (SIN RETRY)
/// =============================
app.use('/bienes', createProxyMiddleware({
  target: SERVICES.bienes,
  changeOrigin: true,
  pathRewrite: (path) => '/api' + path,
  proxyTimeout: 20000,
  timeout: 20000,
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