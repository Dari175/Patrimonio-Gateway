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
  //localhost:5000 es el auth service
  //target: 'http://localhost:5000',
  //Proxy para producción
  target: 'https://patrimonio-apiservice-auth.onrender.com',
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
    req.headers['x-module'] = 'roles'; //
    next();
  },
  createProxyMiddleware({
   //localhost:5000 es el auth service
  //target: 'http://localhost:5000',
  //Proxy para producción
  target: 'https://patrimonio-apiservice-auth.onrender.com',
    changeOrigin: true,
    pathRewrite: { '^/roles': '/' }
  })
);

// =============================
// 👤 USUARIOS
// =============================
app.use('/usuarios',
  (req, res, next) => {
    req.headers['x-module'] = 'usuarios'; //
    next();
  },
  createProxyMiddleware({
  target: 'https://patrimonio-apiservice-auth.onrender.com',
    changeOrigin: true,
    pathRewrite: { '^/usuarios': '/' }
  })
);

// =============================
// 📦 UPLOAD SERVICE
// =============================
app.use('/api/upload', createProxyMiddleware({
  //localhost:6000 es el upload service
  //target: 'http://localhost:6000',
  //Proxy para producción
  target: 'https://patrimonio-loadimages.onrender.com',
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
// 🧠 BIENES SERVICE (AISLADO)
// =============================
app.use('/bienes', createProxyMiddleware({
  //localhost:3001 es el bienes service
  //target: 'http://localhost:3001', 
  //Proxy para producción
  target: 'https://bienes-service-nldc.onrender.com',
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
// ❤️ HEALTH
// =============================
app.get('/health', (req, res) => {
  res.json({ ok: true });
});
// =============================
// 📊 IMPORTADOR SERVICE (PYTHON)
// =============================
app.use('/importador', createProxyMiddleware({
  //localhost:8000 es el importador service
  //target: 'http://127.0.0.1:8000/importar',
  //Proxy para producción
  target: 'https://patrimonio-importexeldb.onrender.com/importar',
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