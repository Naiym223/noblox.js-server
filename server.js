
var express = require('express')
var rbx = require('noblox.js')
var fs = require('fs')
var crypto = require('crypto')
var validator = require('validator')
var bodyParser = require('body-parser')
var Promise = require('bluebird')
const http = require('http');

var app = express()
var port = process.env.PORT || 8080
var settings = require('./settings.json')
var key = settings.key
var maximumRank = settings.maximumRank || 255
const COOKIE = settings.cookie

app.set('env', 'production')

var _setRank = rbx.setRank

rbx.setRank = function (opt) {
  var rank = opt.rank
  if (rank > maximumRank) {
    return Promise.reject(new Error('New rank ' + rank + ' is above rank limit ' + maximumRank))
  } else {
    return _setRank(opt)
  }
}

function sendErr (res, json, status) {
  res.json(json)
}

function validatorType (type) {
  switch (type) {
    case 'int':
      return validator.isInt
    case 'safe_string':
      return validator.isAlphanumeric
    case 'boolean':
      return validator.isBoolean
    case 'string':
      return function (value) {
        return typeof value === 'string'
      }
    default:
      return function () {
        return true
      }
  }
}

function processType (type, value) {
  switch (type) {
    case 'int':
      return parseInt(value, 10)
    case 'boolean':
      return (value === 'true')
    default:
      return value
  }
}

function verifyParameters (res, validate, requiredFields, optionalFields) {
  var result = {}
  if (requiredFields) {
    for (var index in requiredFields) {
      var type = requiredFields[index]
      var use = validatorType(type)

      var found = false
      for (var i = 0; i < validate.length; i++) {
        var value = validate[i][index]
        if (value) {
          if (use(value)) {
            result[index] = processType(type, value)
            found = true
          } else {
            sendErr(res, {error: 'Parameter "' + index + '" is not the correct data type.', id: null})
            return false
          }
          break
        }
      }
      if (!found) {
        sendErr(res, {error: 'Parameter "' + index + '" is required.', id: null})
        return false
      }
    }
  }
  if (optionalFields) {
    for (index in optionalFields) {
      type = optionalFields[index]
      use = validatorType(type)
      for (i = 0; i < validate.length; i++) {
        value = validate[i][index]
        if (value) {
          if (use(value)) {
            result[index] = processType(type, value)
          } else {
            sendErr(res, {error: 'Parameter "' + index + '" is not the correct data type.', id: null})
            return false
          }
          break
        }
      }
    }
  }
  return result
}

function authenticate (req, res, next) {
  if (req.body.key === key) {
    next()
  } else {
    sendErr(res, {error: 'Incorrect authentication key', id: null}, 401)
  }
}

function checkRank (opt) {
  var group = opt.group
  var target = opt.target
  return rbx.getRankInGroup(group, target)
    .then(function (rank) {
      if (rank === 0) {
        throw new Error('Target user ' + target + ' is not in group ' + group)
      }
      if (rank > maximumRank) {
        throw new Error('Original rank ' + rank + ' is above rank limit ' + maximumRank)
      }
      return rank
    })
}

function changeRank (amount) {
  return function (req, res, next) {
    var requiredFields = {
      'group': 'int',
      'target': 'int'
    }
    var validate = [req.params]

    var opt = verifyParameters(res, validate, requiredFields)
    if (!opt) {
      return
    }

    var group = opt.group
    checkRank(opt)
      .then(function (rank) {
        return rbx.getRoles({group: group})
          .then(function (roles) {
            var found
            var foundRank

            // Roles is actually sorted on ROBLOX's side and returned the same way
            for (var i = 0; i < roles.length; i++) {
              var role = roles[i]
              var thisRank = role.Rank
              if (thisRank === rank) {
                var change = i + amount
                found = roles[change]
                if (!found) {
                  sendErr(res, {error: 'Rank change is out of range'})
                  return
                }
                foundRank = found.Rank
                var up = roles[change + 1]
                var down = roles[change - 1]
                if ((up && up.Rank === foundRank) || (down && down.Rank === foundRank)) {
                  sendErr(res, {error: 'There are two or more roles with the same rank number, please change or commit manually.'})
                  return
                }
                var name = found.Name
                opt.rank = foundRank
                return rbx.setRank(opt)
                  .then(function (roleset) {
                    res.json({error: null, data: {newRoleSetId: roleset, newRankName: name, newRank: foundRank}, message: 'Successfully changed rank of user ' + opt.target + ' to rank "' + name + '" in group ' + opt.group})
                  })
              }
            }
          })
      })
      .catch(function (err) {
        sendErr(res, {error: 'Change rank failed: ' + err.message})
      })
  }
}

app.post('/setRank/:group/:target/:rank', authenticate, function (req, res, next) {
  var requiredFields = {
    'group': 'int',
    'rank': 'int',
    'target': 'int'
  }
  var validate = [req.params]
  var opt = verifyParameters(res, validate, requiredFields)
  if (!opt) {
    return
  }
  // This gets the rank manually instead of letting setRank do it because it needs the role's name.
  var rank = opt.rank
  checkRank(opt)
    .then(function () {
      return rbx.getRoles(opt.group)
        .then(function (roles) {
          var role = rbx.getRole(roles, rank)
          if (!role) {
            sendErr(res, {error: 'Role does not exist'})
            return
          }
          var name = role.Name
          return rbx.setRank(opt)
            .then(function (roleset) {
              res.json({error: null, data: {newRoleSetId: roleset, newRankName: name, newRank: rank}, message: 'Successfully changed rank of user ' + opt.target + ' to rank "' + name + '" in group ' + opt.group})
            })
        })
    })
    .catch(function (err) {
      sendErr(res, {error: 'Set rank failed: ' + err.message})
    })
})

app.post('/handleJoinRequest/:group/:username/:accept', authenticate, function (req, res, next) {
  var requiredFields = {
    'group': 'int',
    'username': 'string',
    'accept': 'boolean'
  }
  var validate = [req.params]
  var opt = verifyParameters(res, validate, requiredFields)
  if (!opt) {
    return
  }
  rbx.handleJoinRequest(opt)
    .then(function () {
      res.json({error: null, message: 'Successfully ' + (opt.accept ? 'accepted' : 'declined') + ' ' + opt.username})
    })
    .catch(function (err) {
      sendErr(res, {error: 'Handle join request failed: ' + err.message})
    })
})


app.post('/shout/:group', authenticate, function (req, res, next) {
  var requiredFields = {
    'group': 'int'
  }
  var optionalFields = {
    'message': 'string'
  }
  var validate = [req.params, req.body]
  var opt = verifyParameters(res, validate, requiredFields, optionalFields)
  if (!opt) {
    return
  }
  rbx.shout(opt)
    .then(function () {
      res.json({error: null, message: 'Shouted in group ' + opt.group})
    })
    .catch(function (err) {
      sendErr(res, {error: 'Error: ' + err.message})
    })
})


app.post('/promote/:group/:target', authenticate, function (req, res, next) {
 rbx.promote(req.group, req.target)
})
app.post('/demote/:group/:target', authenticate,  function (req, res, next) {
 rbx.demote(req.group, req.target)
})


app.use(function (err, req, res, next) {
  console.error(err.stack)
  sendErr(res, {error: 'Internal server error'})
})

function login () {
  return rbx.cookieLogin(COOKIE)
}
login().then(function () {
  app.listen(port, function () {
    console.log('Listening on port ' + port)
  })
})
  .catch(function (err) {
    var errorApp = express()
    errorApp.get('/*', function (req, res, next) {
      res.json({error: 'Server configuration error: ' + err.message})
    })
    errorApp.listen(port, function () {
      console.log('Configuration error page listening')
    })
  })

app.get('/', function(req, res, next) {
  res.send("OK BOOTING UP");
});

setInterval(() => {
  http.get(`http://${process.env.PROJECT_DOMAIN}.glitch.me/`);
}, 280000);
