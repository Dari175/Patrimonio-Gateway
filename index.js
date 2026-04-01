const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: true,
  credentials: true
}));

app.use((req, res, next) => {
  console.log(`[GATEWAY] ${req.method} ${req.url}`);
  next();
});

// =============================
// 🔐 AUTH SERVICE
// =============================
app.use('/auth', createProxyMiddleware({
  target: 'http://localhost:5000',
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
// 👥 ROLES
// =============================
app.use('/roles',
  (req, res, next) => {
    req.headers['x-module'] = 'roles'; // 🔥 AQUÍ
    next();
  },
  createProxyMiddleware({
    target: 'http://localhost:5000',
    changeOrigin: true,
    pathRewrite: { '^/roles': '/' }
  })
);

// =============================
// 👤 USUARIOS
// =============================
app.use('/usuarios',
  (req, res, next) => {
    req.headers['x-module'] = 'usuarios'; // 🔥 AQUÍ
    next();
  },
  createProxyMiddleware({
    target: 'http://localhost:5000',
    changeOrigin: true,
    pathRewrite: { '^/usuarios': '/' }
  })
);

// =============================
// 📦 UPLOAD SERVICE
// =============================
app.use('/api/upload', createProxyMiddleware({
  target: 'http://localhost:6000',
  changeOrigin: true,

  pathRewrite: (path) => '/api/upload' + path,

 onProxyReq: (proxyReq, req) => {
  proxyReq.setHeader('ngrok-skip-browser-warning', 'true');

  if (req.headers.authorization) {
    proxyReq.setHeader('Authorization', req.headers.authorization);
  }

  proxyReq.setHeader('x-module', 'roles'); // o usuarios

  }
}));

// =============================
// ❤️ HEALTH
// =============================
app.get('/health', (req, res) => {
  res.json({ ok: true });
});
// =============================
// 📊 IMPORTADOR SERVICE (PYTHON)
// =============================
app.use('/importador', createProxyMiddleware({
  target: 'http://127.0.0.1:8000/importar',
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
  console.log("👉 PATH ORIGINAL:", req.url);
  next();
});

app.listen(PORT, () => {
  console.log(`🚀 Gateway corriendo en http://localhost:${PORT}`);
});