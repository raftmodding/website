var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'Express' });
});
router.get('/forum', function(req, res, next) {
  res.redirect('https://forum.raftmodding.com/');
});
router.get('/discord', function(req, res, next) {
  res.redirect('https://discord.gg/raft');
});
router.get('/docs', function(req, res, next) {
  res.redirect('https://docs.raftmodding.com/');
});

module.exports = router;