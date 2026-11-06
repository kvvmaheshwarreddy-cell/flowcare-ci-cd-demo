const router = require('express').Router();
const { Department } = require('../models/ops');
const { wrap } = require('../middleware/error');

router.get('/', wrap(async (req, res) => res.json(await Department.find().sort('name'))));

module.exports = router;
