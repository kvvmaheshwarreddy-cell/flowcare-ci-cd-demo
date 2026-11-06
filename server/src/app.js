const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { authenticate } = require('./middleware/auth');
const { notFound, errorHandler } = require('./middleware/error');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

// Public
app.use('/api/auth', require('./routes/auth'));

// Everything below requires a valid JWT
app.use('/api', authenticate);
app.use('/api/departments', require('./routes/departments'));
app.use('/api/beds', require('./routes/beds'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/patients', require('./routes/patients'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/forecast', require('./routes/forecast'));
app.use('/api/resources', require('./routes/resources'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/oxygen', require('./routes/oxygen'));
app.use('/api/equipment', require('./routes/equipment'));
app.use('/api/procurement', require('./routes/procurement'));
app.use('/api/users', require('./routes/users'));
app.use('/api/audit-logs', require('./routes/audit'));
app.use('/api', notFound);

// AngularJS front-end
const clientDir = path.join(__dirname, '..', '..', 'client');
app.use(express.static(clientDir));
app.get('*', (req, res) => res.sendFile(path.join(clientDir, 'index.html')));

app.use(errorHandler);

module.exports = app;
