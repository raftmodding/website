'use strict';
/**
 * Accounting and user pages.
 */
module.exports = (logger, db, mail) => {
  var router = require('express').Router();
  var querystring = require('querystring');
  var GoogleRecaptcha = require('google-recaptcha');
  var fs = require('fs');
  var credentials = JSON.parse(fs.readFileSync('database.json'));
  var captchaSecret = credentials.captchaSecret;
  var captchaPublicKey = credentials.captchaPublicKey;
  var captcha = new GoogleRecaptcha({
    secret: captchaSecret});
  var nanoid = require('nanoid');
  var discordAuth = credentials.discord;

  var User = db.User;

  /**
   * Middleware for inserting login status information in the result locals
   * (to be used in pug files).
   */
  router.use((req, res, next) => {
    res.locals.loggedIn = req.session.user && req.cookies.user_sid;
    if (res.locals.loggedIn) {
      db.UserPrivilege.findOne({where: {username: req.session.user.username}})
        .then(privileges => {
          res.locals.userIsAdmin = privileges != null &&
              privileges.role != null && privileges.role === 'admin';
          next();
        }).catch(err => {
          res.locals.userIsAdmin = false;
          logger.error('Could not query user privileges for user ' +
              req.session.user, err);
          next();
        });
    } else {
      next();
    }
  });

  /**
   * Middleware function for redirecting already logged in users.
   */
  var redirectIfLoggedIn = function(req, res, next) {
    if (res.locals.loggedIn) {
      res.redirect(req.query.redirect || '/');
    } else {
      next();
    }
  };

  var requireLogin = function(req, res, next) {
    if (req.session.user && req.cookies.user_sid) {
      next();
    } else {
      res.redirect('/signin?' + querystring.stringify({
        redirect: req.originalUrl,
      }));
    }
  };

  /**
   * Page for logging in.
   */
  router.route(['/signin', '/login'])
    .get(redirectIfLoggedIn, (req, res, next) => {
      res.render('signin', {
        title: 'Sign in',
        redirectQuery: querystring.stringify({redirect: req.query.redirect})});
    })
    .post((req, res) => {
      var username = req.body.username;
      var password = req.body.password;

      User.findOne({ where: { username: username } }).then(function(user) {
        if (!user || !user.validPassword(password)) {
          res.render('signin', {
            title: 'Sign in',
            error: "Sorry, these login details don't seem to be correct.",
            redirectQuery: querystring.stringify({
              redirect: req.query.redirect,
            }),
          });
        } else {
          req.session.user = user;
          res.redirect(req.query.redirect || '/');
        }
      });
    });

  /**
   * Page for creating a new account.
   */
  router.route('/signup')
    .get(redirectIfLoggedIn, (req, res, next) => {
      res.locals.title = 'Sign up';
      res.locals.redirectQuery = querystring
        .stringify({redirect: req.query.redirect});
      res.locals.formContents = req.body;
      res.locals.captchaPublicKey = captchaPublicKey;

      var accountCreation, user;
      if (req.query.confirm) {
        db.AccountCreation.findOne({where: {token: req.query.confirm}})
          .then(accountCreationResult => {
            if (!accountCreationResult) {
              return Promise.reject('This confirmation link is invalid.');
            } else {
              accountCreation = accountCreationResult;
              return db.User.create({
                username: accountCreation.username,
                email: accountCreation.email,
                password: accountCreation.password,
              });
            }
          })
          .then(userResult => {
            user = userResult;
            logger.info(`Account for user ${user.username} was confirmed.`);
            req.session.user = user;
            db.AccountCreation.destroy({where: {id: accountCreation.id}})
              .then(() => {
                logger.debug(`Account creation of user ${user.username} was ` +
                  'completed. Account was moved to users table.');
              });
            res.redirect(req.query.redirect || '/');
          })
          .catch(err => {
            var userMessage;
            if (typeof err === 'string') {
              userMessage = err;
            } else {
              userMessage = 'An unknown error occurred. Please try again ' +
              'later.';
              logger.error('Unexpected error while creating user: ', err);
            }
            res.render('signup', {error: userMessage});
          });
      } else {
        res.render('signup', {
          formContents: {},
        });
      }
    })
    .post((req, res) => {
      // common variables for response rendering
      res.locals.title = 'Sign up';
      res.locals.redirectQuery = querystring
        .stringify({redirect: req.query.redirect});
      res.locals.formContents = req.body;
      res.locals.captchaPublicKey = captchaPublicKey;

      var username = req.body.username;
      var email = req.body.email;
      var password = req.body.password;

      // verify captcha
      verifyCaptcha(req.body['g-recaptcha-response'])
        // check whether a user with the given name or email already exists
        .then(() => db.User.findOne({where: {
          [db.sequelize.Sequelize.Op.or]: [
            {
              username: username,
            },
            {
              email: email,
            },
          ],
        }}))
        .then(user => {
          if (user) {
            return Promise.reject('Sorry, but this username or mail address ' +
              'is already taken. Please pick another one.');
          }
        })
        // begin account creation
        .then(() => db.AccountCreation.create({
          username: username,
          email: email,
          password: password,
          token: nanoid(),
        }))
        // create user session and redirect
        .then(accountCreation => {
          console.log('Began account creation for user '
            + `${accountCreation.username}.`);

          // build links
          var baseUrl = `${req.protocol}://${req.get('host')}/`;
          var verifyLink = `${baseUrl}signup?confirm=${accountCreation.token}`;
          if (res.locals.redirectQuery) {
            verifyLink += `&${res.locals.redirectQuery}`;
          }

          // send confirmation mail
          mail.send(accountCreation.email,
            `Account confirmation for user ${accountCreation.username} ` +
              'on the raft-mods site',
            `Hi ${accountCreation.username},\n\n` +
              `You have requested an account creation on ${baseUrl}. Please ` +
              'click (or copy and paste it into a browser) the following ' +
              `link to confirm that this (${accountCreation.email}) is your ` +
              'email address:\n\n' +
              `\t${verifyLink}\n\n` +
              'If you have not requested an account on our site, you can ' +
              'safely ignore and delete this email. Sorry for the ' +
              'inconveniece!\n\n' +
              'Yours, the Raft-Mods team.'
          );

          // render confirmation notice
          res.render('signup', {verify: true});
        })
        .catch(err => {
          var userMessage;
          if (err instanceof db.sequelize.Sequelize.UniqueConstraintError) {
            userMessage = 'The creation of an account with the given username' +
              ' or email address is already in process.';
          } else if (typeof err === 'string') {
            // string errors should be from verifyCaptcha
            userMessage = err;
          } else {
            userMessage = 'An unknown error occurred. Please try again ' +
            'later.';
            logger.error('Unexpected error while creating user: ', err);
          }
          res.render('signup', {error: userMessage});
        });
    });

  function verifyCaptcha(captchaResponse) {
    return new Promise((resolve, reject) => {
      // check whether the captcha was answered
      if (!captchaResponse)
        return reject('Please complete the captcha.');

      // verify correct captcha
      captcha.verify({response: captchaResponse}, (err, body) => {
        if (err) {
          // handle timeout or duplicate error
          if (body &&
              Array.isArray(body['error-codes']) &&
              body['error-codes'].includes('timeout-or-duplicate')) {
            return reject('Please complete the captcha again.');
          } else {
            // any other error
            logger.error('An error occurred while checking the signup ' +
              'captcha:', err);
            return reject('Sorry, there is a problem with the captcha.');
          }
        } else {
          // no error --> correct captcha
          return resolve();
        }
      });
    });
  }

  /**
   * Page to reset a forgotten password.
   */
  router.route('/forgotpassword')
    .get(redirectIfLoggedIn, (req, res, next) => {
      res.locals.title = 'Forgot password';
      res.locals.redirectQuery = querystring
        .stringify({redirect: req.query.redirect});
      res.locals.formContents = {};
      res.locals.captchaPublicKey = captchaPublicKey;

      if (req.query.resetToken) {
        db.PasswordReset.findOne({where: {token: req.query.resetToken}})
          .then(passwordReset => {
            if (!passwordReset) {
              return Promise.reject('This confirmation link is invalid.');
            } else {
              res.render('account/forgotpassword',
                {resetToken: passwordReset.token});
            }
          })
          .catch(err => {
            var userMessage;
            if (typeof err === 'string') {
              userMessage = err;
            } else {
              userMessage = 'An unknown error occurred. Please try again ' +
              'later.';
              logger.error('Unexpected error while querying db for password ' +
                'reset: ', err);
            }
            res.render('account/forgotpassword', {error: userMessage});
          });
      } else {
        res.render('account/forgotpassword');
      }
    })
    .post(redirectIfLoggedIn, (req, res, next) => {
      res.locals.title = 'Forgot password';
      res.locals.redirectQuery = querystring
        .stringify({redirect: req.query.redirect});
      res.locals.formContents = req.body;
      res.locals.captchaPublicKey = captchaPublicKey;

      if (req.body.resetToken) {
        res.locals.resetToken = req.body.resetToken;
        var passwordReset;
        verifyCaptcha(req.body['g-recaptcha-response'])
          .then(() => db.PasswordReset
            .findOne({where: {token: req.body.resetToken}}))
          .then(passwordResetResult => {
            if (!passwordResetResult) {
              res.locals.reset = true;
              return Promise.reject('This password reset link is invalid.');
            } else {
              passwordReset = passwordResetResult;
              if (!req.body.newPassword ||
                !req.body.confirmPassword) {
                return Promise.reject('Please enter your new password twice.');
                // eslint-disable-next-line max-len
              } else if (!/^(?=.*[A-Z])(?=.*[!@#$&*])(?=.*[0-9])(?=.*[a-z]).{8,}$/.test(req.body.newPassword)) {
                return Promise.reject('This new password is not strong ' +
                  'enough.');
              } else if (req.body.newPassword !== req.body.confirmPassword) {
                return Promise.reject('The passwords do not match. Please ' +
                'enter your new password twice.');
              } else {
                return db.User.update({password: req.body.newPassword},
                  {where: {id: passwordReset.userId}, individualHooks: true});
              }
            }
          })
          .then(user => {
            if (user[0] === 0) return Promise.reject('Could not update ' +
              'password. Does the account still exist?');
            res.locals.formContents.newPassword = '********';
            res.locals.formContents.confirmPassword = '********';
            res.render('account/forgotpassword', {reset: true});
            db.PasswordReset.destroy({where: {userId: passwordReset.userId}})
              .then(() => {
                logger.debug('Password reset for user (' + passwordReset.userId
                  + ') was completed. Password reset entry was deleted.');
              });
          })
          .catch(err => {
            var userMessage;
            if (typeof err === 'string') {
              userMessage = err;
            } else {
              userMessage = 'An unknown error occurred. Please try again ' +
              'later.';
              logger.error('Unexpected error while querying the database for ' +
                'password resets: ', err);
            }
            res.render('account/forgotpassword', {error: userMessage});
          });
      } else if (!req.body.email) {
        res.render('account/forgotpassword',
          {error: 'Please enter an email address to proceed.'});
      } else {
        var user;
        verifyCaptcha(req.body['g-recaptcha-response'])
          .then(() => db.User.findOne({where: {email: req.body.email}}))
          .then(userResult => {
            if (!userResult) return Promise.reject('Sorry, we couldn\'t find ' +
              'an account with that address.');
            else {
              user = userResult;
              return db.PasswordReset.create({
                userId: user.id,
                token: nanoid(),
              });
            }
          })
          .then(passwordReset => {
            console.log('Began password reset for user '
              + `(${passwordReset.userId}).`);

            // build links
            var baseUrl = `${req.protocol}://${req.get('host')}/`;
            var resetLink = `${baseUrl}forgotpassword?resetToken=` +
              passwordReset.token;
            if (res.locals.redirectQuery) {
              resetLink += `&${res.locals.redirectQuery}`;
            }

            // send reset mail
            mail.send(user.email,
              `Password for user ${user.username} ` +
                'on the raft-mods site',
              `Hi ${user.username},\n\n` +
                `You have requested to reset your password on ${baseUrl}. ` +
                'Please click (or copy and paste it into a browser) the ' +
                'following link to enter a new password:\n\n' +
                `\t${resetLink}\n\n` +
                'If you have not requested to reset your password, you can ' +
                'safely ignore and delete this email. Sorry for the ' +
                'inconveniece!\n\n' +
                'Yours, the Raft-Mods team.'
            );

            // render confirmation notice
            res.render('account/forgotpassword', {
              reset: true,
            });
          })
          .catch(err => {
            var userMsg;
            if (err instanceof db.sequelize.Sequelize.UniqueConstraintError) {
              userMsg = 'A password reset for your account is already in ' +
                'progress! Please check your mailbox (and your spam folder).';
            } else if (typeof err === 'string') {
              // string errors should be from verifyCaptcha
              userMsg = err;
            } else {
              userMsg = 'An unknown error occurred. Please try again ' +
              'later.';
              logger.error('Unexpected error while beginning password reset: ',
                err);
            }
            res.render('account/forgotpassword', {error: userMsg});
          });
      }
    });

  /**
   * Page that shows information about the own account.
   */
  router.get('/account', requireLogin, (req, res, next) => {
    res.render('account', {title: 'Account', user: req.session.user});
  });

  /**
   * Page for changing your own password.
   */
  router.route('/account/password')
    .get(requireLogin, (req, res, next) => {
      res.render('change-password', {title: 'Change your password',
        formContents: {}});
    }).post(requireLogin, (req, res, next) => {
      User.findOne({where: {username: req.session.user.username}})
        .then(user => {
          if (!req.body.currentPassword ||
              !req.body.newPassword ||
              !req.body.confirmPassword) {
            res.render('change-password', {
              title: 'Change your password',
              error: 'You need to fill all fields of this form to change ' +
                'your password.',
              formContents: req.body,
            });
          } else if (!user.validPassword(req.body.currentPassword)) {
            res.render('change-password', {
              title: 'Change your password',
              error: 'Your current password is wrong.',
              formContents: req.body,
            });
            // eslint-disable-next-line max-len
          } else if (!/^(?=.*[A-Z])(?=.*[!@#$&*])(?=.*[0-9])(?=.*[a-z]).{8,}$/.test(req.body.newPassword)) {
            res.render('change-password', {
              title: 'Change your password',
              error: 'This new password is not strong enough.',
              formContents: req.body,
            });
          } else if (req.body.newPassword !== req.body.confirmPassword) {
            res.render('change-password', {
              title: 'Change your password',
              error: 'The confirm-password doesn\'t match your new password.',
              formContents: req.body,
            });
          } else {
            User.update({password: req.body.newPassword},
              {where: {username: req.session.user.username},
                individualHooks: true})
              .then(user => {
                res.render('change-password', {
                  title: 'Change your password',
                  success: 'You successfully changed your password.',
                  formContents: {},
                });
              }).catch(err => {
                res.render('change-password', {
                  title: 'Change your password',
                  error: 'An error occurred.',
                  formContents: req.body,
                });
                console.log('An error occurred while updating user password ' +
                  `for user ${req.session.user.username}:`, err);
              });
          }
        }).catch(err => {
          res.render('change-password', {
            title: 'Change your password',
            error: 'An error occurred.',
            formContents: req.body,
          });
          console.log('An error occurred while updating user password ' +
            `for user ${req.session.user.username}:`, err);
        });
    });

  /**
   * Accessing this page will log the user out (and redirect him).
   */
  router.get(['/signout', '/logout'], (req, res) => {
    if (req.session.user && req.cookies.user_sid) {
      req.session.destroy();
      res.redirect('/');
    } else {
      res.redirect('/login');
    }
  });

  /**
   * Redirect to the logged in user's own profile page.
   */
  router.get('/user/me', requireLogin, (req, res, next) => {
    res.redirect('/user/' + req.session.user.username);
  });

  /**
   * Public user page showing the user's mods.
   */
  router.get('/user/:id', function(req, res, next) {
    User.findOne({where: {username: req.params.id}})
      .then(user => {
        if (user == null) {
          next();
        } else {
          db.Mod.findAll({where: {author: user.username}})
            .then(mods => {
              res.render('user', {
                title: user.username,
                user: user,
                authoredMods: mods,
                userIsOwner: (req.session.user &&
                req.cookies.user_sid &&
                user.username === req.session.user.username),
              });
            })
            .catch(err => {
              res.render('error', {title: 'Database error',
                error: {status: 500}});
              console.log('Error while querying database for user ' +
                req.params.id + '\'s mods:', err);
            });
        }
      })
      .catch(err => {
        res.render('error', {title: 'Database error', error: {status: 500}});
        console.log('Error while querying database for user ' +
          req.params.id + ':',
        err);
      });
  });

  const fetch = require('node-fetch');
  const btoa = require('btoa');

  router.route('/auth/discord')
    .get(redirectIfLoggedIn, (req, res, next) => {
      console.log(req.session);
      if (req.query.code) {
        res.locals.redirect = '';
        res.locals.formContents = {};

        const code = req.query.code;
        const creds = btoa(`${discordAuth.clientId}:${discordAuth.secret}`);
        var params = querystring.stringify({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: `${req.protocol}://${req.get('host')}/auth/discord`,
        });
        fetch(`https://discordapp.com/api/oauth2/token?${params}`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${creds}`,
          },
        })
          .then(res => res.json())
          .then(tokenResponse => {
            if (tokenResponse.error) {
              res.locals.retry = true;
              return Promise.reject('Invalid code.');
            } else {
              return fetch('https://discordapp.com/api/users/@me', {
                method: 'GET',
                headers: {
                  Authorization: `Bearer ${tokenResponse.access_token}`,
                },
              });
            }
          })
          .then(res => res.json())
          .then(json => {
            res.render('account/signup-discord', {
              discordName: json.username,
              discordDiscriminator: json.discriminator,
            });
          })
          .catch(err => {
            if (typeof err === 'string') {
              res.render('account/signup-discord', {error: err});
            } else {
              next(err);
            }
          });
      } else {
        var params2 = querystring.stringify({
          client_id: discordAuth.clientId,
          response_type: 'code',
          scope: 'identify',
          redirect_uri: `${req.protocol}://${req.get('host')}/auth/discord`,
        });
        res.redirect(`https://discordapp.com/oauth2/authorize?${params2}`);
      }
    })
    .post(redirectIfLoggedIn, (req, res, next) => {
      if (req.body.chooseUsername) {
        res.locals.formContents = req.body;

        if (!req.body.username) {
          res.render('account/signup-discord', {
            error: 'Please choose a user name to sign up!',
          });
        } else {
          db.User.findOne({where: {username: req.body.username}})
            .then(userResult => {
              if (userResult) return Promise.reject('Sorry, but this ' +
                'username is already taken. Please pick another one.');
              else {
                res.send('create account');
              }
            })
            .catch(err => {
              if (typeof err === 'string') {
                res.render('account/signup-discord', {error: err});
              } else {
                next(err);
              }
            });
        }
      } else {
        res.render('account/signup-discord', {retry: true});
      }
    });

  return router;
};
