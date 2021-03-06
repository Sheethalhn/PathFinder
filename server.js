// See LICENSE.MD for license information.

'use strict';

/********************************
Dependencies
********************************/
var express = require('express'),// server middleware
    mongoose = require('mongoose'),// MongoDB connection library
    bodyParser = require('body-parser'),// parse HTTP requests
    passport = require('passport'),// Authentication framework
    LocalStrategy = require('passport-local').Strategy,
    expressValidator = require('express-validator'), // validation tool for processing user input
    cookieParser = require('cookie-parser'),
    session = require('express-session'),
    MongoStore = require('connect-mongo/es5')(session), // store sessions in MongoDB for persistence
    bcrypt = require('bcrypt'), // middleware to encrypt/decrypt passwords
    sessionDB,

    cfenv = require('cfenv'),// Cloud Foundry Environment Variables
    appEnv = cfenv.getAppEnv(),// Grab environment variables

    User = require('./server/models/user.model'),
    Jobseeker = require('./server/models/jobseeker.model'),
    Jobposter = require('./server/models/jobposter.model')

var request = require("request");




/********************************
Local Environment Variables
 ********************************/
if(appEnv.isLocal){
    require('dotenv').load();// Loads .env file into environment
}

/********************************
 MongoDB Connection
 ********************************/

//Detects environment and connects to appropriate DB
if(appEnv.isLocal){
    mongoose.connect(process.env.LOCAL_MONGODB_URL);
    sessionDB = process.env.LOCAL_MONGODB_URL;
    console.log('Your MongoDB is running at ' + process.env.LOCAL_MONGODB_URL);
}
// Connect to MongoDB Service on Bluemix
else if(!appEnv.isLocal) {
    var mongoDbUrl, mongoDbOptions = {};
    var mongoDbCredentials = appEnv.services["compose-for-mongodb"][0].credentials;
    var ca = [new Buffer(mongoDbCredentials.ca_certificate_base64, 'base64')];
    mongoDbUrl = mongoDbCredentials.uri;
    mongoDbOptions = {
      mongos: {
        ssl: true,
        sslValidate: true,
        sslCA: ca,
        poolSize: 1,
        reconnectTries: 1
      }
    };

    console.log("Your MongoDB is running at ", mongoDbUrl);
    mongoose.connect(mongoDbUrl, mongoDbOptions); // connect to our database
    sessionDB = mongoDbUrl;
}
else{
    console.log('Unable to connect to MongoDB.');
}




/********************************
Express Settings
********************************/
var app = express();
app.enable('trust proxy');
// Use SSL connection provided by Bluemix. No setup required besides redirecting all HTTP requests to HTTPS
if (!appEnv.isLocal) {
    app.use(function (req, res, next) {
        if (req.secure) // returns true is protocol = https
            next();
        else
            res.redirect('https://' + req.headers.host + req.url);
    });
}
app.use(express.static(__dirname + '/public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended:true}));
app.use(expressValidator()); // must go directly after bodyParser
app.use(cookieParser());
app.use(session({
    secret: process.env.SESSION_SECRET || 'this_is_a_default_session_secret_in_case_one_is_not_defined',
    resave: true,
    store: new MongoStore({
        url: sessionDB,
        autoReconnect: true
    }),
    saveUninitialized : false,
    cookie: { secure: false }
}));
app.use(passport.initialize());
app.use(passport.session());



/********************************
 Passport Middleware Configuration
 ********************************/
passport.serializeUser(function(user, done) {
    done(null, user.id);
});

passport.deserializeUser(function(id, done) {
    User.findById(id, function (err, user) {
        done(err, user);
    });
});

passport.use(new LocalStrategy(
    function(username, password, done) {
        User.findOne({ username: username }, function (err, user) {
            if (err) {
                return done(err);
            }
            if (!user) {
                return done(null, false, { message: 'Incorrect username.' });
            }
            // validatePassword method defined in user.model.js
            if (!user.validatePassword(password, user.password)) {
                return done(null, false, { message: 'Incorrect password.' });
            }
            return done(null, user);
        });
    }
));

/********************************
 Routing
 ********************************/

// Home
app.get('/', function (req, res){
    res.sendfile('index.html');
});

// Account login
app.post('/account/login', function(req,res){

    // Validation prior to checking DB. Front end validation exists, but this functions as a fail-safe
    req.checkBody('username', 'Username is required').notEmpty();
    req.checkBody('password', 'Password is required').notEmpty();

    var errors = req.validationErrors(); // returns an object with results of validation check
    if (errors) {
        res.status(401).send('Username or password was left empty. Please complete both fields and re-submit.');
        return;
    }

    // Create session if username exists and password is correct
    passport.authenticate('local', function(err, user) {
        if (err) { return next(err); }
        if (!user) { return res.status(401).send('User not found. Please check your entry and try again.'); }
        req.logIn(user, function(err) { // creates session
            if (err) { return res.status(500).send('Error saving session.'); }
            var userInfo = {
                username: user.username,
                firstname : user.firstname,
                lastname : user.lastname,
                email : user.email,
                role: user.role
            };
            return res.json(userInfo);
        });
    })(req, res);

});

// Account creation
app.post('/account/create', function(req,res){

    // 1. Input validation. Front end validation exists, but this functions as a fail-safe
    req.checkBody('username', 'Username is required').notEmpty();
    req.checkBody('password', 'Password is required').notEmpty();
    req.checkBody('firstname', 'First Name is required').notEmpty();
    req.checkBody('lastname',  'Last Name is required').notEmpty();
    req.checkBody('role', 'Role is required, must be a Jobseeker or Jobposter').notEmpty();
    req.checkBody('email', 'Email is required and must be in a valid form').notEmpty().isEmail();

    var errors = req.validationErrors(); // returns an array with results of validation check
    if (errors) {
        res.status(400).send(errors);
        return;
    }

    // 2. Hash user's password for safe-keeping in DB
    var salt = bcrypt.genSaltSync(10),
        hash = bcrypt.hashSync(req.body.password, salt);

    // 3. Create new object that store's new user data
    var user = new User({
        username: req.body.username,
        password: hash,
        email: req.body.email,
        firstname: req.body.firstname,
        lastname: req.body.lastname,
        role: req.body.role
    });

    // 4. Store the data in MongoDB
    User.findOne({ username: req.body.username }, function(err, existingUser) {
        if (existingUser) {
            return res.status(400).send('That username already exists. Please try a different username.');
        }
        user.save(function(err) {
            if (err) {
                console.log(err);
                res.status(500).send('Error saving new account (database error). Please try again.');
                return;
            }
            res.status(200).send('Account created! Please login with your new account.');
        });
    });

});

//Account deletion
app.post('/account/delete', authorizeRequest, function(req, res){

    User.remove({ username: req.body.username }, function(err) {
        if (err) {
            console.log(err);
            res.status(500).send('Error deleting account.');
            return;
        }
        req.session.destroy(function(err) {
            if(err){
                res.status(500).send('Error deleting account.');
                console.log("Error deleting session: " + err);
                return;
            }
            res.status(200).send('Account successfully deleted.');
        });
    });

});

// Account update
app.post('/account/update', authorizeRequest, function(req,res){

    // 1. Input validation. Front end validation exists, but this functions as a fail-safe
    req.checkBody('username', 'Username is required').notEmpty();
    req.checkBody('password', 'Password is required').notEmpty();
    req.checkBody('firstname', 'First Name is required').notEmpty();
    req.checkBody('lastname', 'Last Name is required').notEmpty();

    req.checkBody('email', 'Email is required and must be in a valid form').notEmpty().isEmail();

    var errors = req.validationErrors(); // returns an object with results of validation check
    if (errors) {
        res.status(400).send(errors);
        return;
    }

    // 2. Hash user's password for safe-keeping in DB
    var salt = bcrypt.genSaltSync(10),
        hash = bcrypt.hashSync(req.body.password, salt);

    // 3. Store updated data in MongoDB
    User.findOne({ username: req.body.username }, function(err, user) {
        if (err) {
            console.log(err);
            return res.status(400).send('Error updating account.');
        }
        user.username = req.body.username;
        user.password = hash;
        user.email = req.body.email;
        user.firstname = req.body.firstname;
        user.lastname = req.body.lastname;

        user.save(function(err) {
            if (err) {
                console.log(err);
                res.status(500).send('Error updating account.');
                return;
            }
            res.status(200).send('Account updated.');
        });
    });

});

// Account logout
app.get('/account/logout', function(req,res){

    // Destroys user's session
    if (!req.user)
        res.status(400).send('User not logged in.');
    else {
        req.session.destroy(function(err) {
            if(err){
                res.status(500).send('Sorry. Server error in logout process.');
                console.log("Error destroying session: " + err);
                return;
            }
            res.status(200).send('Success logging user out!');
        });
    }

});

// EXPLORE JOBS STUFFS


// Get All Jobs for non logged in user
app.get('/explore/jobs', function(req,res){


    console.log("Persona: " + req.query.persona);
    console.log("Industry: " + req.query.industry);
    Jobposter.find({ industry: req.query.industry, persona: req.query.persona }, function(err, jobs) {
        if (err) {
            console.log(err);
            return res.status(400).send('Error finding jobs.');
        }
        return res.json(jobs);
    });
});

// Get Specific Jobsfor non logged in user
app.get('/explore/job/view', function(req,res){

    Jobposter.findOne({ _id: req.query.job_id}, function(err, job) {
        if (err) {
            console.log(err);
            return res.status(400).send('Error finding job.');
        }
        return res.json(job);
    });
});

// JOB SEEKER STUFFS

// Persona Update
app.post('/quiz/persona', authorizeRequest, function(req,res){

    // 1. Input validation. Front end validation exists, but this functions as a fail-safe
    req.checkBody('username', 'Username is required').notEmpty();
    req.checkBody('email', 'Email is required').notEmpty();
    req.checkBody('firstname', 'Email is required').notEmpty();
    req.checkBody('lastname', 'Email is required').notEmpty();
    req.checkBody('persona', 'Persona is required').notEmpty();

    var errors = req.validationErrors(); // returns an object with results of validation check
    if (errors) {
        res.status(400).send(errors);
        return;
    }

    // 2. Store updated data in MongoDB
    Jobseeker.findOne({ username: req.body.username }, function(err, user) {
        if (err) {
            console.log(err);
            return res.status(400).send('Error updating account.');
        }

        if (user == null){
          // Create new object that store's new user data
          var user = new Jobseeker({
              username: req.body.username,
              email: req.body.email,
              firstname: req.body.firstname,
              lastname: req.body.lastname,
              persona: req.body.persona
          });
        }

        user.persona = req.body.persona;

        user.save(function(err) {
            if (err) {
                console.log(err);
                res.status(500).send('Error updating account.');
                return;
            }
            res.status(200).send('Persona updated!');
        });
    });

});

// Get Persona
app.get('/quiz/persona', authorizeRequest, function(req,res){

    // 1. Get data in MongoDB
    Jobseeker.findOne({ username: req.query.username}, function(err, user) {

        if (user == null){
          return res.json("intern");
        }

        return res.json(user.persona);
    });

});

// Industry Update
app.post('/quiz/industry', authorizeRequest, function(req,res){

    // 1. Input validation. Front end validation exists, but this functions as a fail-safe
    req.checkBody('username', 'Username is required').notEmpty();
    req.checkBody('industry', 'Industry is required').notEmpty();

    var errors = req.validationErrors(); // returns an object with results of validation check
    if (errors) {
        res.status(400).send(errors);
        return;
    }

    // 2. Store updated data in MongoDB
    Jobseeker.findOne({ username: req.body.username }, function(err, user) {
        if (err) {
            console.log(err);
            return res.status(400).send('Error updating account.');
        }
        user.industry = req.body.industry;

        user.save(function(err) {
            if (err) {
                console.log(err);
                res.status(500).send('Error updating account.');
                return;
            }
            res.status(200).send('Industry updated!');
        });
    });

});

// Get Industry
app.get('/quiz/industry', authorizeRequest, function(req,res){

    // 1. Get data in MongoDB
    Jobseeker.findOne({ username: req.query.username}, function(err, user) {

        if (user == null){
          return;
        }

        return res.json(user.industry);
    });

});

// Personality Update
app.post('/quiz/personality', authorizeRequest, function(req,res){

    // 1. Input validation. Front end validation exists, but this functions as a fail-safe
    req.checkBody('username', 'Username is required').notEmpty();
    req.checkBody('q1', 'Q1 is required').notEmpty();
    req.checkBody('q2', 'Q2 is required').notEmpty();
    req.checkBody('q3', 'Q3 is required').notEmpty();
    req.checkBody('q4', 'Q4 is required').notEmpty();
    req.checkBody('q5', 'Q5 is required').notEmpty();
    req.checkBody('q6', 'Q6 is required').notEmpty();

    var errors = req.validationErrors(); // returns an object with results of validation check
    if (errors) {
        res.status(400).send(errors);
        return;
    }

    // 2. Store updated data in MongoDB
    Jobseeker.findOne({ username: req.body.username }, function(err, user) {
        if (err) {
            console.log(err);
            return res.status(400).send('Error updating account.');
        }

        user.username = req.body.username;
        user.q1 = req.body.q1;
        user.q2 = req.body.q2;
        user.q3 = req.body.q3;
        user.q4 = req.body.q4;
        user.q5 = req.body.q5;
        user.q6 = req.body.q6;

        // Get personality insights
        var post_body = req.body.q1 + " " + req.body.q2 + " " + req.body.q3 + " " + req.body.q4 + " " + req.body.q5 + " " + req.body.q6;
        var request = require("request");
        // console.log("post_body", post_body);

        var options = {
            method: 'POST',
            url: 'https://watson-api-explorer.mybluemix.net/personality-insights/api/v3/profile',
            auth: {
                user: '30d55ab4-a84c-434c-90dd-49742f96b0c7',
                password: 'aKicDJRQv5fM'
            },
            qs:
            {
                version: '2016-05-20',
                raw_scores: 'false',
                csv_headers: 'false',
                consumption_preferences: 'false'
            },
            headers:
            {
                'Cache-Control': 'no-cache',
                'Accept-Language': 'en',
                'Content-Language': 'en',
                Accept: 'application/json',
                'Content-Type': 'text/plain'
            },
            body: post_body
        };
        // console.log("options", options);


        request(options, function (error, response, body) {
            // console.log("response", response);
            if (error) {
                console.log("error", error);
                throw new Error(error);
            }

            // console.log("body", body);
            var p = JSON.parse(body);
            // Extract the personality scores
            for (var p_trait in p.personality) {
                if (p.personality[p_trait].trait_id == 'big5_openness') {
                    user.emotional = (p.personality[p_trait].percentile * 100);
                }
                if (p.personality[p_trait].trait_id == 'big5_extraversion') {
                    user.extrovert = (p.personality[p_trait].percentile * 100);
                }
            }

            for (var n_trait in p.needs) {
                if (p.needs[n_trait].trait_id == 'need_structure') {
                    user.structure = (p.needs[n_trait].percentile * 100) / 10;
                }
                if (p.needs[n_trait].trait_id == 'need_curiosity') {
                    user.curiosity = (p.needs[n_trait].percentile * 100) / 10;
                }
                if (p.needs[n_trait].trait_id == 'need_challenge') {
                    user.challenge = (p.needs[n_trait].percentile * 100) / 10;
                }
            }

            for (var trait in p.values) {
                if (p.values[trait].trait_id == 'value_openness_to_change') {
                    user.stimulation = (p.values[trait].percentile * 100) / 10;
                }
                if (p.values[trait].trait_id == 'value_self_transcendence') {
                    user.help = (p.values[trait].percentile * 100) / 10;
                }
            }

            user.save(function (err) {
                console.log(user);
                if (err) {
                    console.log(err);
                    res.status(500).send('Error updating account.');
                    return;
                }
                res.status(200).send('Personality questions updated!');
            });
        });
    });

});



// Get Personality
app.get('/quiz/personality', authorizeRequest, function(req,res){

    // 1. Get data in MongoDB
    Jobseeker.findOne({ username: req.query.username}, function(err, user) {

        if (user == null){
          return res.json(undefined);
        }

        return res.json({
          'q1': user.q1,
          'q2': user.q2,
          'q3': user.q3,
          'q4': user.q4,
          'q5': user.q5,
          'q6': user.q6}
        );
    });

});


// Perk Update
app.post('/quiz/perks', authorizeRequest, function(req,res){

    // 1. Input validation. Front end validation exists, but this functions as a fail-safe
    req.checkBody('username', 'Username is required').notEmpty();

    var errors = req.validationErrors(); // returns an object with results of validation check
    if (errors) {
        res.status(400).send(errors);
        return;
    }

    // 2. Store updated data in MongoDB
    Jobseeker.findOne({ username: req.body.username }, function(err, user) {
        if (err) {
            console.log(err);
            return res.status(400).send('Error updating account.');
        }

        user.username = req.body.username;
        user.perks = req.body.perks;

        user.save(function(err) {
            if (err) {
                console.log(err);
                res.status(500).send('Error updating account.');
                return;
            }
            res.status(200).send('Personality questions updated!');
        });
    });

});

// Get Personality
app.get('/quiz/perks', authorizeRequest, function(req,res){


    console.log("Username: " + req.query.username);
    console.log("Persona: " + req.query.persona);
    console.log("Industry: " + req.query.industry);

    // 1. Get data in MongoDB
    Promise.all(
      [
        Jobseeker.findOne({ username: req.query.username}, {perks: 1}),
        Jobposter.find({persona:req.query.persona, industry: req.query.industry}, {perks:1})
      ]
    ).then( ([ jobseeker_perks, jobposts ]) => {

      // Get list of perks from jobseeker
      console.log(jobseeker_perks);

      // Get list of perks from Job Posts
      var unique_perks = {};

      for (var job in jobposts){
        var perks = jobposts[job].perks;
        for (var i=0; i < perks.length; i++){
          unique_perks[perks[i].value] = perks[i].value;
        }
      }

      var finalperks = [];
      for ( var key in unique_perks )
          finalperks.push({ id: unique_perks[key], perk: unique_perks[key], checked: false} );

      console.log("Final Perks");
      console.log(finalperks);

      // Intersect perks from jobs and user
      var perks = jobseeker_perks.perks;
      for ( var i = 0; i < perks.length; i++){
        console.log(perks[i])

        for (var j = 0; j < finalperks.length; j++){
          if (finalperks[j].perk == perks[i].perk){
            console.log("FOUND MATCH");
            finalperks[j].checked = perks[i].checked;
          }
        }
      }

      return res.json(finalperks);

    });

});


// Resume Update
app.post('/quiz/resume', authorizeRequest, function(req,res){

    // 1. Input validation. Front end validation exists, but this functions as a fail-safe
    req.checkBody('username', 'Username is required').notEmpty();

    var errors = req.validationErrors(); // returns an object with results of validation check
    if (errors) {
        res.status(400).send(errors);
        return;
    }

    // 2. Store updated data in MongoDB
    Jobseeker.findOne({ username: req.body.username }, function(err, user) {
        if (err) {
            console.log(err);
            return res.status(400).send('Error updating account.');
        }

        user.username = req.body.username;
        user.experience = req.body.experience;
        user.education = req.body.education;
        user.skills = req.body.skills;

        user.save(function(err) {
            if (err) {
                console.log(err);
                res.status(500).send('Error updating account.');
                return;
            }
            res.status(200).send('Personality questions updated!');
        });
    });

});

// Get Resume
app.get('/quiz/resume', authorizeRequest, function(req,res){

    // 1. Get data in MongoDB
    Jobseeker.findOne({ username: req.query.username}, function(err, user) {

        if (user == null){
          return res.json(undefined);
        }

        return res.json({
          'experience': user.experience,
          'education': user.education,
          'skills': user.skills}
        );
    });

});

// Get Jobs
app.get('/jobseeker/jobs', authorizeRequest, function(req,res){


    console.log("Username: " + req.query.username);
    // 1. Get data in MongoDB
    Promise.all(
      [
        Jobseeker.findOne({ username: req.query.username}),
      ]
    ).then( ([ jobseeker]) => {

      // Get list of jobs in same industry and persona

      console.log("Looking for jobs for " + jobseeker.industry + " " + jobseeker.persona);
      Jobposter.find({ industry: jobseeker.industry, persona:jobseeker.persona }, function(err, jobs) {
          if (err) {
              console.log(err);
              return res.status(400).send('Error finding jobs.');
          }

          var jobseeker_skills = [];
          for (var i = 0; i < jobseeker.skills.length; i++) {
              jobseeker_skills.push(jobseeker.skills[i].value);
          }
          console.log("jobseeker_skills", jobseeker_skills);
          // For each job, find the match
          for (var j in jobs) {
              var job_skills = [];
              for (var i = 0; i < jobs[j].skills.length; i++) {
                  job_skills.push(jobs[j].skills[i].value);
              }
              var num_req_skills = job_skills.length;

              // Get % of skills that match, that is # present / req
              var num_match = 0;
              console.log("Job skills", job_skills);
              for (var i = 0; i < job_skills.length; i++) {
                  // console.log(job_skills[i]);
                  if (jobseeker_skills.indexOf(job_skills[i]) != -1) {
                      num_match++;
                  }
              }
              console.log("num match", num_match);

              // Skills match counts for 80%
              var skills_match = (num_match / num_req_skills) * 80;

              console.log("skills_match", skills_match);

              // Calculate percent match for personality
              var RMSE = 0;
              var personality_match = 0;
              var map = {};
              map[(jobs[j].emotionalSlider)] = jobseeker.emotional;
              map[(jobs[j].extrovertSlider)] = jobseeker.extrovert;
              map[(jobs[j].unplannedSlider)] = jobseeker.structure;
              map[(jobs[j].challengeSlider)] = jobseeker.challenge;
              map[(jobs[j].noveltySlider)] = jobseeker.stimulation;
              map[(jobs[j].helpSlider)] = jobseeker.help;

              if (!Object.entries)
                 Object.entries = function( obj ){
                    var ownProps = Object.keys( obj ),
                       i = ownProps.length,
                       resArray = new Array(i); // preallocate the Array

                    while (i--)
                       resArray[i] = [ownProps[i], obj[ownProps[i]]];
                    return resArray;
                 };

              for (var [key, value] of Object.entries(map)) {
                  if (key != undefined && value != undefined) {
                      RMSE = RMSE + Math.pow((parseInt(key) - value), 2);
                  }
                  //console.log(key, value);
              }

              RMSE = Math.sqrt(RMSE / 6);
              console.log("RMSE: ", RMSE);

              personality_match = (100 - RMSE);
              console.log("personality_match: ", personality_match);

              // Personality counts for 20%
              var personality_weight = 0.2;

              // Skills counts for 80%
              var skills_weight = 0.8;

              // total match formula
              var total_match = skills_match * skills_weight + personality_match * personality_weight;

              console.log("total_match: ", total_match);
              jobs[j].ranking = total_match.toFixed(1);
          }
          return res.json(jobs);

      });
    });
});

// Get a specific jobs
app.get('/jobseeker/job/view', authorizeRequest, function(req,res){


    console.log("Username: " + req.query.username);
    console.log("Job ID: " + req.query.job_id)
    // 1. Get data in MongoDB
    Promise.all(
      [
        Jobseeker.findOne({ username: req.query.username}),
        Jobposter.findOne({ _id: req.query.job_id})
      ]
    ).then( ([jobseeker, job]) => {

      console.log("FOUND JOB");
      console.log(job);

      console.log("FOUND JOBSEEKER");
      console.log(jobseeker);


      // TODO:
      // Here we have the jobseeker and job information
      // Put the logic for finding the skill gaps here and trainings
      if(jobseeker != undefined){

        var skill_gap = [];
        // Get Skills Needed
        for(var i = 0; i < job.skills.length; i++){
          skill_gap.push({'skill': job.skills[i].value, 'trainings': []});
        }

        // Remove Skills that Jobseeker already has
        for(var i  = 0; i < jobseeker.skills.length; i++){
          for(var j = 0; j < skill_gap.length; j++){
            if (jobseeker.skills[i].value == skill_gap[j].skill){
              skill_gap.splice(j,1);
            }
          }
        }

        // Iterate through skill gaps, execute rest call to get google cse results
        /*
        var options = { method: 'GET',
          url: 'https://www.googleapis.com/customsearch/v1',
          qs:
           { key: 'AIzaSyB178s4XLvqkJRRRrvZT4YX-_9rKb-tzek',
             num: '4',
             cx: '000150702483990711318:hrirdu5mxc8',
             q: ''
             },
          headers:
           { 'Postman-Token': '19276978-5091-4a03-bcf5-0f6831031a02',
             'Cache-Control': 'no-cache' } };

        for(var i = 0; i < skill_gap.length; i++  ){
          // send request for google cse
          console.log(skill_gap[i].trainings);
          options.qs.q = skill_gap[i].skill;
          console.log(options);
          request(options, function (error, response, body) {

            res = JSON.parse(body);
            console.log(res);

          });
        }*/
        console.log("SKILL GAPS");

        console.log(skill_gap);
        job.skill_gap = skill_gap;
      }

      return res.json(job);
    });
});


// JOB POSTER STUFFS

// Post Job
app.post('/post/job', authorizeRequest, function(req,res){

    // 1. Input validation. Front end validation exists, but this functions as a fail-safe
    req.checkBody('username', 'Username is required').notEmpty();
    req.checkBody('email', 'Email is required').notEmpty();
    req.checkBody('title', 'Title is required').notEmpty();
    req.checkBody('company', 'Company is required').notEmpty();
    req.checkBody('summary', 'Summary is required').notEmpty();
    req.checkBody('city', 'City is required').notEmpty();
    req.checkBody('state', 'State is required').notEmpty();
    req.checkBody('persona', 'Persona is required').notEmpty();
    req.checkBody('industry', 'Industry is required').notEmpty();

    req.checkBody('emotionalSlider', 'emotionalSlider is required').notEmpty();
    req.checkBody('extrovertSlider', 'extrovertSlider is required').notEmpty();
    req.checkBody('unplannedSlider', 'unplannedSlider is required').notEmpty();
    req.checkBody('orgSlider', 'orgSlider is required').notEmpty();
    req.checkBody('growthSlider', 'growthSlider is required').notEmpty();
    req.checkBody('challengeSlider', 'challengeSlider is required').notEmpty();
    req.checkBody('noveltySlider', 'noveltySlider is required').notEmpty();
    req.checkBody('helpSlider', 'helpSlider is required').notEmpty();


    var errors = req.validationErrors(); // returns an object with results of validation check
    if (errors) {
        res.status(400).send(errors);
        return;
    }
    // 2. Create new object that store's new user data
    var jobpost = new Jobposter({
        username: req.body.username,
        email: req.body.email,
        title: req.body.title,
        company: req.body.company,
        logourl: req.body.logourl,
        summary: req.body.summary,
        description: req.body.description,
        city: req.body.city,
        state: req.body.state,
        persona: req.body.persona,
        industry: req.body.industry,
        skills: req.body.skills,
        perks: req.body.perks,
        emotionalSlider: req.body.emotionalSlider,
        extrovertSlider: req.body.extrovertSlider,
        unplannedSlider: req.body.unplannedSlider,
        orgSlider: req.body.orgSlider,
        growthSlider: req.body.growthSlider,
        challengeSlider: req.body.challengeSlider,
        noveltySlider: req.body.noveltySlider,
        helpSlider: req.body.helpSlider
    });

    jobpost.save(function(err) {
        if (err) {
            console.log(err);
            res.status(500).send('Error saving post.');
            return;
        }
        res.status(200).send('Job post saved!');
    });


});

// Get Jobs for jobposter
app.get('/jobposter/jobs', authorizeRequest, function(req,res){


    console.log("Username: " + req.query.username);
    // 1. Get data in MongoDB
    Promise.all(
      [
        Jobposter.find({ username: req.query.username}),
      ]
    ).then( ([jobs]) => {

      return res.json(jobs);

    });
});


app.post('/update/job', authorizeRequest, function(req,res){

    // 1. Input validation. Front end validation exists, but this functions as a fail-safe
    req.checkBody('id', 'id is required').notEmpty();
    req.checkBody('username', 'Username is required').notEmpty();
    req.checkBody('email', 'Email is required').notEmpty();
    req.checkBody('title', 'Title is required').notEmpty();
    req.checkBody('company', 'Company is required').notEmpty();
    req.checkBody('summary', 'Summary is required').notEmpty();
    req.checkBody('city', 'City is required').notEmpty();
    req.checkBody('state', 'State is required').notEmpty();
    req.checkBody('persona', 'Persona is required').notEmpty();
    req.checkBody('industry', 'Industry is required').notEmpty();

    req.checkBody('emotionalSlider', 'emotionalSlider is required').notEmpty();
    req.checkBody('extrovertSlider', 'extrovertSlider is required').notEmpty();
    req.checkBody('unplannedSlider', 'unplannedSlider is required').notEmpty();
    req.checkBody('orgSlider', 'orgSlider is required').notEmpty();
    req.checkBody('growthSlider', 'growthSlider is required').notEmpty();
    req.checkBody('challengeSlider', 'challengeSlider is required').notEmpty();
    req.checkBody('noveltySlider', 'noveltySlider is required').notEmpty();
    req.checkBody('helpSlider', 'helpSlider is required').notEmpty();


    var errors = req.validationErrors(); // returns an object with results of validation check
    if (errors) {
        res.status(400).send(errors);
        return;
    }

    // 2. Fetch job in MongoDB and update
    Jobposter.findOne({ _id: req.body.id}, function(err, job) {
        if (err) {
            console.log(err);
            return res.status(400).send('Error updating job.');
        }

        console.log("JOB");
        console.log(job);

        job.title = req.body.title;
        job.company = req.body.company;
        job.logourl = req.body.logourl;
        job.summary = req.body.summary;
        job.description = req.body.description;
        job.city = req.body.city;
        job.state = req.body.state;
        job.persona = req.body.persona;
        job.industry = req.body.industry;
        job.skills = req.body.skills;
        job.perks = req.body.perks;
        job.emotionalSlider = req.body.emotionalSlider;
        job.extrovertSlider = req.body.extrovertSlider;
        job.unplannedSlider = req.body.unplannedSlider;
        job.orgSlider = req.body.orgSlider;
        job.growthSlider = req.body.growthSlider;
        job.challengeSlider = req.body.challengeSlider;
        job.noveltySlider = req.body.noveltySlider;
        job.helpSlider = req.body.helpSlider;

        job.save(function(err) {
            if (err) {
                console.log(err);
                res.status(500).send('Error updating job.');
                return;
            }
            res.status(200).send('Job posting updated!');
        });
    });

});

//Account deletion
app.post('/job/delete', authorizeRequest, function(req, res){

    Jobposter.remove({ _id: req.body.job_id }, function(err) {
        if (err) {
            console.log(err);
            res.status(500).send('Error deleting job.');
            return;
        }

        res.status(200).send('Job successfully deleted.');
    });
});


// Get Candidates for Specific Job Posting
app.get('/jobposter/jobs/candidates', authorizeRequest, function(req,res){

    // 1. Input validation. Front end validation exists, but this functions as a fail-safe
    req.checkQuery('job_id', 'Job ID is required').notEmpty();

    var errors = req.validationErrors(); // returns an object with results of validation check
    if (errors) {
        res.status(400).send(errors);
        return;
    }

    // 2. Get data in MongoDB
    Promise.all(
      [
        Jobposter.findOne({ _id: req.query.job_id})
      ]
    ).then( ([job]) => {

      console.log("Looking for jobseeker for: " + job.persona + " and " + job.industry);
      Jobseeker.find({ industry: job.industry, persona:job.persona }, function(err, jobseekers) {
          if (err) {
              console.log(err);
              return res.status(400).send('Error finding jobseekers');
          }

          //
          //TODO: Here we have jobpost and list of possible jobseeker_jobs
          // Put logic here to rank jobseekers with jobpost
          //
          console.log(jobseekers);

          var job_skills = [];
          for (var i = 0; i < job.skills.length; i++) {
              job_skills.push(job.skills[i].value);
          }
          var num_req_skills = job_skills.length;
          console.log("job_skills", jobseeker_skills);
          // For each job, find the match
          for (var j in jobseekers) {
              var jobseeker_skills = [];
              for (var i = 0; i < jobseekers[j].skills.length; i++) {
                  jobseeker_skills.push(jobseekers[j].skills[i].value);
              }

              // Get % of skills that match, that is # present / req
              var num_match = 0;
              console.log("Job skills", jobseeker_skills);

              for (var i = 0; i < job_skills.length; i++) {
                  // console.log(job_skills[i]);
                  if (jobseeker_skills.indexOf(job_skills[i]) != -1) {
                      num_match++;
                  }
              }
              console.log("num match", num_match);

              // Skills match counts for 80%
              var skills_match = (num_match / num_req_skills) * 80;

              console.log("skills_match", skills_match);

              // Calculate percent match for personality
              var RMSE = 0;
              var personality_match = 0;
              var map = {};
              map[(job.emotionalSlider)] = jobseekers[j].emotional;
              map[(job.extrovertSlider)] = jobseekers[j].extrovert;
              map[(job.unplannedSlider)] = jobseekers[j].structure;
              map[(job.challengeSlider)] = jobseekers[j].challenge;
              map[(job.noveltySlider)] = jobseekers[j].stimulation;
              map[(job.helpSlider)] = jobseekers[j].help;


              if (!Object.entries)
                 Object.entries = function( obj ){
                    var ownProps = Object.keys( obj ),
                       i = ownProps.length,
                       resArray = new Array(i); // preallocate the Array

                    while (i--)
                       resArray[i] = [ownProps[i], obj[ownProps[i]]];
                    return resArray;
                 };

              for (var [key, value] of Object.entries(map)) {
                  if (key != undefined && value != undefined) {
                      RMSE = RMSE + Math.pow((parseInt(key) - value), 2);
                  }
                  //console.log(key, value);
              }

              RMSE = Math.sqrt(RMSE / 6);
              console.log("RMSE: ", RMSE);

              personality_match = (100 - RMSE);
              console.log("personality_match: ", personality_match);

              // Personality counts for 20%
              var personality_weight = 0.2;

              // Skills counts for 80%
              var skills_weight = 0.8;

              // total match formula
              var total_match = skills_match * skills_weight + personality_match * personality_weight;

              console.log("total_match: ", total_match);
              jobseekers[j].ranking = total_match.toFixed(1);
              console.log("!!", jobseekers[j].ranking, "!!");
          }
          return res.json(jobseekers);

        });
    });
});



// Get Candidate
app.get('/jobposter/jobs/candidate', authorizeRequest, function(req,res){

    // 1. Input validation. Front end validation exists, but this functions as a fail-safe
    req.checkQuery('candidate_id', 'Candidate ID is required').notEmpty();

    var errors = req.validationErrors(); // returns an object with results of validation check
    if (errors) {
        res.status(400).send(errors);
        return;
    }

    // 2. Get data in MongoDB
    Promise.all(
      [
        Jobseeker.findOne({ _id: req.query.candidate_id})
      ]
    ).then( ([jobseeker]) => {

      console.log(jobseeker);
      return res.json(jobseeker);

    });
});


// Custom middleware to check if user is logged-in
function authorizeRequest(req, res, next) {

    if (req.user) {
        next();
    } else {
        res.status(401).send('Unauthorized. Please login.');
    }
}

// Protected route requiring authorization to access.
app.get('/protected', authorizeRequest, function(req, res){
    res.send("This is a protected route only visible to authenticated users.");
});

/********************************
Ports
********************************/
app.listen(appEnv.port, appEnv.bind, function() {
  console.log("Node server running on " + appEnv.url);
});
