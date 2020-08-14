const express = require('express'),
    session = require('express-session'),
    cookieParser = require('cookie-parser'),
    passport = require('passport'),
    SpotifyStrategy = require('passport-spotify').Strategy,
    RememberMeStrategy = require('passport-remember-me').Strategy,
    mysql = require('mysql'),
    axios = require('axios'),
    getSong = require('genius-lyrics-api').getSong,
    utils = require('./utils'),
    path = require('path');

let SPOTIFYCLIENTKEY = process.env.SPOTIFYCLIENTKEY,
    SPOTIFYSECRETKEY = process.env.SPOTIFYSECRETKEY,
    GENIUSACCESSTOKEN = process.env.GENIUSACCESSTOKEN,
    SESSIONSECRET = process.env.SESSIONSECRET;

var connection = mysql.createConnection({
    host     : '',
    user     : '',
    password : '',
    database : ''
});

passport.use(new RememberMeStrategy(
    function(token, done) {
        consumeRememberMeToken(token, function(err, result) {
            if (err) { return done(err); }
            if (!result) { return done(null, false); }
            findById(result.uid, function(err, user) {
                if (err) { return done(err); }
                if (!user) { return done(null, false); }
                return done(null, user);
            });
        });
    },
    issueToken
));

function issueToken(user, done) {
    var token = utils.randomString(64);
    saveRememberMeToken(token, user.id, function(err) {
        if (err) { return done(err); }
        return done(null, token);
    });
}

passport.serializeUser(function(user, done) {
    done(null, user.id)
});

passport.deserializeUser(function(user, done) {
    findById(user, function (err, user) {
        done(err, user);
    });
});

passport.use(
    new SpotifyStrategy(
        {
            clientID: SPOTIFYCLIENTKEY,
            clientSecret: SPOTIFYSECRETKEY,
            callbackURL: 'http://localhost:8080/callback'
        },
        function(accessToken, refreshToken, expires_in, profile, done) {
            process.nextTick(function() {
                findById(profile.id, function(err, user) {
                    if (err) { return done(err); }
                    if (!user) {
                        connection.query('INSERT IGNORE INTO Users (id, refresh_token) VALUES (?,?);', [profile.id, refreshToken],
                            function (error, results, fields) {
                                if (error) throw error;
                        });
                        user = {id: profile.id, refresh_token: refreshToken};
                    } else {
                        connection.query('UPDATE Users SET refresh_token = ? WHERE id = ?', [refreshToken, user.id],
                            function (error, results, fields) {
                                if (error) throw error;
                            });
                        user = {id: profile.id, refresh_token: refreshToken};
                    }
                    return done(null, {
                        id: user.id,
                        refresh_token: user.refresh_token
                    });
                })
            });
        }
    )
);

const app = express();

app.set('views', __dirname + path.sep + 'views');
app.set('view engine', 'pug');
app.use(express.static(__dirname + path.sep + 'public'));
app.use(cookieParser());
app.use(session({
    secret: SESSIONSECRET,
    resave: true,
    saveUninitialized: true
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(passport.authenticate('remember-me'));

app.get('/', function(req, res) {
    if (req.user) {
        refreshToken(req.user.refresh_token)
        .then((res_access_token) => {
            getCurrentlyPlayingSong(res_access_token.data.access_token)
            .then((res_song) => {
                switch (res_song.status) {
                    case 200:
                        let data = getSongData(res_song);
                        let track = data[0],
                            artist = data[1],
                            image = data[2];

                        const options = {
                            apiKey: GENIUSACCESSTOKEN,
                            title: track,
                            artist: artist,
                            optimizeQuery: true
                        };
                        getSong(options)
                        .then((song) => {
                            console.log(req.user.id);
                            console.log(artist + " - " + track);
                            res.render('lyrics', {
                                trackName: track,
                                artistName: artist,
                                image: image,
                                lyrics: song.lyrics.split('\n'),
                                url: song.url
                            })
                        }).catch((error) => {
                            res.render('dialog', {title: "ERROR", message: "Song is not on Genius.com."})
                        });
                        break;
                    case 204:
                        res.render('dialog', {title: "ERROR", message: "Could not get the currently playing song. Try disabling private mode or play a song."});
                        break;
                    default:
                        res.render('dialog', {title: "ERROR", message: "Something went wrong. We are launching an investigation."})
                }
            })
            .catch((error) => {
                res.render('dialog', {title: "ERROR", message: "Could not get the currently playing song. " + error})
            });
        })
        .catch((error) => {
            res.render('dialog', {title: "ERROR", message: "Could not establish a connection with Spotify. " + error})
        });
    } else {
        res.render('index', {});
    }
});

app.get('/auth/spotify',
    passport.authenticate('spotify', {
        scope: ['user-read-currently-playing'],
        showDialog: true
    }),
    function(req, res) {}
);

app.get('/callback',
    passport.authenticate('spotify', { failureRedirect: '/login' }),
    function(req, res, next) {
        res.render('dialog', {title: "REMEMBER USER?", message: ""});
    }
);

app.get('/remember', function(req, res, next) {
    issueToken(req.user, function(err, token) {
        if (err) { return next(err); }
        res.cookie('remember_me', token, { path: '/', httpOnly: true, maxAge: 15770000000});
        res.redirect('/');
    })
});

app.get('/refresh', ensureAuthenticated, function(req, res) {
    res.redirect('/');
});

app.get('/logout', function(req, res) {
    res.clearCookie('remember_me');
    connection.query('DELETE FROM Users WHERE id = ?;', req.user.id,
        function (error, results, fields) {
            if (error) throw error;
        });
    connection.query('DELETE FROM Tokens WHERE uid = ?;', req.user.id,
        function (error, results, fields) {
            if (error) throw error;
        });
    req.logout();
    res.redirect('/');
});

app.listen(8080);

function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect('/login');
}

function refreshToken(refresh_token) {
    return axios({
        method: 'POST',
        url: 'https://accounts.spotify.com/api/token',
        params: {
            grant_type: 'refresh_token',
            refresh_token: refresh_token
        },
        headers: {
            'Authorization': 'Basic ' + Buffer.from(`${SPOTIFYCLIENTKEY}:${SPOTIFYSECRETKEY}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });
}

function getCurrentlyPlayingSong(access_token) {
    return axios({
        method: 'GET',
        url: 'https://api.spotify.com/v1/me/player/currently-playing',
        params: {
        },
        headers: {
            'Authorization': 'Bearer ' + access_token,
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });
}

function getSongData(song) {
    let artist = song.data.item.artists[0].name,
        track = song.data.item.name,
        image = song.data.item.album.images[0].url;
    return [track, artist, image];
}

function findById(id, fn) {
    connection.query('SELECT * FROM Users WHERE id = ?;', id,
        function (error, results, fields) {
            if (error) throw error;
            let user = null;
            if (results.length > 0) {
                user = {id: results[0].id, refresh_token: results[0].refresh_token}
            }
            fn(null, user);
        });
}

function consumeRememberMeToken(token, fn) {
    connection.query('SELECT uid FROM Tokens WHERE token = ?;', token,
        function (error, results, fields) {
            if (error) return fn(error, null);
            connection.query('DELETE FROM Tokens WHERE token = ?;', token,
                function (error, results, fields) {
                    if (error) return fn(error, null);
                });
            return fn(null, results[0]);
        });
}

function saveRememberMeToken(token, uid, fn) {
    connection.query('INSERT INTO Tokens (token, uid) VALUES (?, ?);', [token, uid],
        function (error, results, fields) {
            if (error) throw error;
            return fn();
        });
}
