require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const mysql = require('mysql2/promise');
const path = require('path');
const { body, validationResult } = require('express-validator');

const app = express();
app.use(express.json());
const PORT = process.env.PORT;

const dbConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
};

const pool = mysql.createPool({ ...dbConfig });

app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL,
}, async (accessToken, refreshToken, profile, done) => {
  try {
    // First, check if the user exists in the attendance table
    const [attendanceRows] = await pool.query('SELECT * FROM attendance WHERE attendee_email = ?', [profile.emails[0].value]);
    const isAttendanceVerified = attendanceRows.length > 0;

    // Now, insert or update the user, including the attendance_verified flag
    const [rows] = await pool.query(`
      INSERT INTO users (email, name, profile_picture, attendance_verified)
      VALUES (?, ?, ?, ?) 
      ON DUPLICATE KEY UPDATE name = ?, profile_picture = ?, attendance_verified = ?
    `, [
      profile.emails[0].value, 
      profile.displayName, 
      profile.photos[0].value, 
      isAttendanceVerified ? 1 : 0,
      profile.displayName, 
      profile.photos[0].value,
      isAttendanceVerified ? 1 : 0
    ]);

    // Fetch the updated user data
    const [userRows] = await pool.query('SELECT * FROM users WHERE email = ?', [profile.emails[0].value]);
    const user = userRows[0];

    return done(null, user);
  } catch (error) {
    return done(error);
  }
}));

passport.serializeUser((user, done) => {
  done(null, user.email);
});

passport.deserializeUser(async (email, done) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    const user = rows[0];
    done(null, user);
  } catch (error) {
    done(error);
  }
});

// Global error handling middleware
app.use((err, req, res, next) => {
  if (err.code === 'ETIMEDOUT') {
    res.redirect('/login.html');
  } else {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Custom middleware for authentication
const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  } else {
    res.redirect('/login.html');
  }
};

// Modify the isAuthenticatedAndOnboarded middleware
const isAuthenticatedAndOnboarded = (req, res, next) => {
  if (req.isAuthenticated()) {
    const userEmail = req.user.email;
    pool.query('SELECT * FROM users WHERE email = ?', [userEmail])
      .then(([userRows]) => {
        const user = userRows[0];
        if (user && user.onboarded === 0) {
          res.redirect('/onboarding.html');
        } else if (user && user.onboarded === 1) {
          next();
        } else {
          res.redirect('/login.html');
        }
      })
      .catch(error => {
        console.error('Error checking user onboarding status:', error);
        res.redirect('/login.html');
      });
  } else {
    res.redirect('/login.html');
  }
};

// Route to serve onboarding.html
app.get('/onboarding.html', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, '/public/onboarding.html'));
});

// User service or utility function
const getUserData = async (req, res) => {
  if (!req.user) {
    return null;
  }

  const sanitizedUser = {
    name: req.user.name,
    email: req.user.email,
    profile_picture: req.user.profile_picture,
    semester: req.user.semester,
    onboarded: req.user.onboarded,
  };

  return sanitizedUser;
};

// Route to fetch user data
app.get('/user', isAuthenticated, async (req, res) => {
  try {
    const userData = await getUserData(req);

    if (!userData) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    res.json({ user: userData });
  } catch (err) {
    console.error('Error fetching user data:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Function to update academic year in the Users table
async function updateAcademicYear(userEmail, semester) {
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth();

  let academicYear;
  if (currentMonth < 6) {  // Before July
    academicYear = `${currentYear - 1}-${currentYear}`;
  } else {  // July onwards
    academicYear = `${currentYear}-${currentYear + 1}`;
  }

  try {
    const query = `UPDATE users SET academic_year = ? WHERE email = ?`;
    await pool.query(query, [academicYear, userEmail]);
    console.log('Academic year updated successfully');
  } catch (error) {
    console.error('Error updating academic year:', error);
    throw error;
  }
}

// Add this new route to check the onboarding step
app.get('/checkOnboardingStep', isAuthenticated, async (req, res) => {
  try {
      const [rows] = await pool.query('SELECT onboarding_step FROM users WHERE email = ?', [req.user.email]);
      if (rows.length > 0) {
          res.json({ step: rows[0].onboarding_step });
      } else {
          res.json({ step: 1 });
      }
  } catch (error) {
      console.error('Error checking onboarding step:', error);
      res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/updateUserData', isAuthenticated, [
  body('roll_number').isString().notEmpty(),
  body('branch').isIn(['IT', 'COMPS', 'EXTC']),
  body('semester').isIn(['V', 'VI', 'VII']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
  }

  const { roll_number, branch, semester } = req.body;
  const userEmail = req.user.email;

  try {
      await pool.query(
          'UPDATE users SET roll_number = ?, branch = ?, semester = ?, onboarding_step = 2 WHERE email = ?',
          [roll_number, branch, semester, userEmail]
      );

      res.json({ success: true, message: 'User data updated successfully' });
  } catch (error) {
      console.error('Error updating user data:', error);
      res.status(500).json({ success: false, message: 'Failed to update user data' });
  }
});

async function isValidEnumValue(tableName, fieldName, value) {
  try {
    const query = `
      SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = ? AND COLUMN_NAME = ?;
    `;
    const [rows] = await pool.query(query, [tableName, fieldName]);

    if (!rows || rows.length === 0 || !rows[0].COLUMN_TYPE) {
      console.error('No COLUMN_TYPE found for the specified field.');
      return false;
    }

    const enumValues = rows[0].COLUMN_TYPE.match(/'([^']+)'/g).map(enumValue => enumValue.replace(/'/g, ''));
    return enumValues.includes(value);
  } catch (error) {
    console.error('Error checking enum value:', error);
    return false;
  }
}

// Route to fetch online course data from the database
app.get('/api/courses', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM courses_online;');
    res.json(rows);
  } catch (error) {
    console.error('Error fetching online courses:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route to fetch offline course data from the database
app.get('/api/courses_offline', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM courses_offline;');
    res.json(rows);
  } catch (error) {
    console.error('Error fetching offline courses:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route to check attendance verification
app.get('/checkAttendance', isAuthenticated, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const [rows] = await pool.query('SELECT attendance_verified FROM users WHERE email = ?', [userEmail]);
    const attendanceVerified = rows[0].attendance_verified === 1;
    res.json({ attendanceVerified });
  } catch (error) {
    console.error('Error checking attendance:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Endpoint to handle course enrollment
app.post('/api/enroll', isAuthenticated, async (req, res) => {
  console.log('Enrollment request received:', req.body);

  try {
    const { courses } = req.body;
    
    if (!Array.isArray(courses) || courses.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid courses data' });
    }

    // Validate the courses data
    for (const course of courses) {
      if (!course.email) {
        return res.status(400).json({ success: false, message: 'Email is missing' });
      }
      if (!course.course_id) {
        return res.status(400).json({ success: false, message: 'Course ID is missing' });
      }
      if (!course.mode) {
        return res.status(400).json({ success: false, message: 'Mode is missing' });
      }
      if (!course.type) {
        return res.status(400).json({ success: false, message: 'Type is missing' });
      }
      if (!course.enrolled_semester) {
        return res.status(400).json({ success: false, message: 'Enrolled semester is missing' });
      }
      if (!course.enrolled_academic_year) {
        return res.status(400).json({ success: false, message: 'Enrolled academic year is missing' });
      }

      // Validate mode
      if (course.mode !== 'ONLINE' && course.mode !== 'OFFLINE') {
        return res.status(400).json({ success: false, message: 'Invalid mode value' });
      }
      
      // Validate type
      if (course.type !== 'OET' && course.type !== 'OEHM') {
        return res.status(400).json({ success: false, message: 'Invalid type value' });
      }

      // Validate total_hours (can be null for offline courses)
      if (course.mode === 'ONLINE' && (course.total_hours === null || isNaN(course.total_hours))) {
        return res.status(400).json({ success: false, message: 'Invalid total hours for online course' });
      }
    }

    // Insert the courses into the database
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      for (const course of courses) {
        await connection.query(
          'INSERT INTO enrollments (email, course_id, total_hours, mode, type, enrolled_semester, enrolled_academic_year) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [course.email, course.course_id, course.total_hours, course.mode, course.type, course.enrolled_semester, course.enrolled_academic_year]
        );
      }

      // Set onboarded to 1
      await connection.query('UPDATE users SET onboarded = 1 WHERE email = ?', [req.user.email]);

      await connection.commit();
      res.json({ success: true, message: 'Enrollment successful' });
    } catch (error) {
      await connection.rollback();
      console.error('Database error during enrollment:', error);
      res.status(500).json({ success: false, message: 'Enrollment failed due to a database error' });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Error processing enrollment:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Route to serve successful-onboarding.html
app.get('/successful-onboarding', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, '/public/successful-onboarding.html'));
});

// Logout route
app.get('/logout', (req, res) => {
  req.logout((err) => err ? res.send('Error logging out') : res.redirect('/login.html'));
});

// Google authentication routes
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => res.redirect(req.user.onboarded ? '/index.html' : '/onboarding.html')
);

// Route to serve index.html
app.get(['/', '/index.html'], isAuthenticatedAndOnboarded, (req, res) => {
  res.sendFile(path.join(__dirname, '/public/index.html'));
});

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`Server is running on http://localhost:${PORT}`)); 