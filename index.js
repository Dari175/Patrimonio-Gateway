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
// WAKE-UP INTELIGENTE
// =============================
const wakeServiceIfNeeded = async (baseUrl) => {
  try {
    await fetch(baseUrl + '/health');
  } catch (err) {
    console.log('[WAKE] Servicio dormido, despertando:', baseUrl);

    await fetch(baseUrl + '/health').catch(() => null);

    await new Promise(resolve => setTimeout(resolve, 3000));
  }
};


// =============================
// LOGIN MANUAL
// =============================
app.post('/auth/login', async (req, res) => {
  try {
    await wakeServiceIfNeeded(SERVICES.auth);

    const response = await fetch(SERVICES.auth + '/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers.authorization && {
          Authorization: req.headers.authorization
        })
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);

  } catch (error) {
    res.status(502).json({
      error: 'Error en login'
    });
  }
});


// =============================
// PROXY SEGURO
// =============================
const createSafeProxy = (config) => {
  return createProxyMiddleware({
    ...config,
    proxyTimeout: 20000,
    timeout: 20000,

    onError: async (err, req, res) => {
      console.log('[PROXY ERROR]', err.code);

      if (res.headersSent) return;

      // NO retry en GET (evita 429)
      if (req.method === 'GET') {
        return res.status(502).json({
          error: 'Servicio temporalmente no disponible'
        });
      }

      try {
        const target = config.target;

        console.log('[RECOVERY] Despertando servicio:', target);

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
app.use('/auth', async (req, res, next) => {
  await wakeServiceIfNeeded(SERVICES.auth);
  next();
});

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
// UPLOAD SERVICE
// =============================
app.use('/api/upload',
  async (req, res, next) => {
    await wakeServiceIfNeeded(SERVICES.upload);
    next();
  },
  createSafeProxy({
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
  })
);


// =============================
// BIENES SERVICE
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
    timeout: 20000,
    onProxyReq: (proxyReq, req) => {
      proxyReq.setHeader('ngrok-skip-browser-warning', 'true');

      if (req.headers.authorization) {
        proxyReq.setHeader('Authorization', req.headers.authorization);
      }
    }
  })
);


// =============================
// HEALTH
// =============================
app.get('/health', (req, res) => {
  res.json({ ok: true });
});


// =============================
// IMPORTADOR SERVICE
// =============================
app.use('/importador',
  async (req, res, next) => {
    await wakeServiceIfNeeded(SERVICES.importador);
    next();
  },
  createSafeProxy({
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
  })
);

app.use('/importador', (req, res, next) => {
  console.log("PATH ORIGINAL:", req.url);
  next();
});


app.listen(PORT, () => {
  console.log(`Gateway corriendo en puerto ${PORT}`);
});