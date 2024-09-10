const express = require('express');
const bodyParser = require('body-parser')

const cors = require('cors')
const bcrypt = require('bcryptjs')
const client = require('./connection')
const jwt = require('jsonwebtoken')
client.connect();
const app = express();
app.use(cors());
app.use(bodyParser.json());


const port = process.env.PORT || 3000

app.listen(port, () => {
  console.log(`Sever is now listening at port ${port}`);
})

app.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await client.query(
      'INSERT INTO "usersReg" (u_name, u_password, u_email) VALUES ($1, $2, $3) RETURNING *',
      [name, hashedPassword, email]
    );

    if (result.rows.length > 0) {
      res.status(201).json('Register succes!');
    } else {
      res.status(400).send('No data returned from the database');
    }
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).send('Server Error');
  }
});

app.post('/login', async (req, res) => {

  try {
    const { email, password } = req.body;

    const result = await client.query('SELECT * FROM "usersReg" WHERE u_email = $1', [email])

    const user = result.rows[0]

    if (!user) {
      return res.status(400).json({ message: "Invalid Credentials" })
    }

    const isPasswordMatch = await bcrypt.compare(password, user['u_password'])

    if (!isPasswordMatch) {
      return res.status(400).json({ message: "Invalid Credentials" })
    }

    const token = jwt.sign({ userId: user.id }, process.env.SECRET_KEY, {
      expiresIn: '1d'
    })

    res.json({ token })
  } catch (error) {
    console.log(error);
    res.status(500).send('Server Error')
  }
})

async function verifyToken(req, res, next) {
  const token = req.headers.authorization && req.headers.authorization.split(' ')[1]

  if (!token) {
    return res.status(401).json({ message: "Missing token" })
  }

  try {
    const decoded = jwt.verify(token, process.env.SECRET_KEY);

    if (decoded) {
      const result = await client.query('SELECT * FROM "usersReg" WHERE id = $1', [decoded.userId]);

      if (result.rows.length > 0) {
        req.user = result.rows[0];
        next();
      } else {
        res.status(404).json({ message: "User not found" });
      }
    } else {
      res.status(401).json({ message: "Invalid token" });
    }
  } catch (error) {
    console.error('Token verification failed', error.message);
    res.status(401).send('Invalid token');
  }
}

app.get('/userinfo', verifyToken, (req, res) => {
  res.json({ user: req.user });
});

app.post('/posts', verifyToken, async (req, res) => {
  const { title, description } = req.body;

  const user_id = req.user.id

  const insertQuery = `INSERT INTO posts(title, content, user_id) VALUES($1, $2, $3) RETURNING *`;

  try {
    const result = await client.query(insertQuery, [title, description, user_id]);
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error on add post:', err);
    res.status(500).send('Error on add post');
  }
})

app.get('/posts', verifyToken, async (req, res) => {
  if (!req.user) {
    return res.status(401).send('Token not found');
  }
  const user_id = req.user.id;



  try {
    const query = `
    WITH like_dislike_counts AS (
  SELECT
    v.entity_id AS post_id,
    COUNT(CASE WHEN v.vote_type = TRUE THEN 1 END)::INTEGER AS likes_count,
    COUNT(CASE WHEN v.vote_type = FALSE THEN 1 END)::INTEGER AS dislikes_count
  FROM votes v
  WHERE v.entity_type = 'post'
  GROUP BY v.entity_id
),
user_votes AS (
  SELECT
    v.entity_id AS post_id,
    MAX(CASE WHEN v.user_id = $1 THEN CASE WHEN v.vote_type THEN 1 ELSE 0 END ELSE NULL END) AS user_vote
  FROM votes v
  WHERE v.entity_type = 'post'
  GROUP BY v.entity_id
)
SELECT
  p.*,
  COALESCE(lc.likes_count, 0) AS likes_count,
  COALESCE(lc.dislikes_count, 0) AS dislikes_count,
  uv.user_vote,
  COUNT(c.id)::INTEGER AS comments_count
FROM posts p
LEFT JOIN like_dislike_counts lc ON p.id = lc.post_id
LEFT JOIN user_votes uv ON p.id = uv.post_id
LEFT JOIN comments c ON p.id = c.post_id
GROUP BY p.id, lc.likes_count, lc.dislikes_count, uv.user_vote
ORDER BY p.created_at DESC;
    `;

    const result = await client.query(query, [user_id]);

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error on get posts:', err);
    res.status(500).send('Error on get posts');
  }
})

app.get('/posts/:id', verifyToken, async (req, res) => {
  if (!req.user) {
    return res.status(401).send('Token not found');
  }
  const postId = req.params.id;

  const insertQuery = `SELECT
                         posts.*,
                         "usersReg".u_name,
                         "usersReg".u_email
                       FROM
                         posts
                       JOIN
                         "usersReg" ON "usersReg".id = posts.user_id
                       WHERE
                         posts.id = $1`;
  try {
    const result = await client.query(insertQuery, [postId]);
    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error on get post:', error);
    res.status(500).send('Error on get post');
  }

  client.end;
})

app.get('/comments/:id', verifyToken, async (req, res) => {
  const postId = req.params.id

  const insertQuery = `
    SELECT "comments".*, "usersReg".u_name
    FROM comments
    INNER JOIN "usersReg" ON "comments".user_id = "usersReg".id
    WHERE "comments".post_id = $1;
  `
  try {
    const result = await client.query(insertQuery, [postId]);
    const comments = result.rows;

    const map = new Map();
    const roots = [];
    comments.forEach(comment => {
      map.set(comment.id, { ...comment, replies: [] });
    });
    comments.forEach(comment => {
      if (comment.parent_comment_id) {
        const parent = map.get(comment.parent_comment_id);
        if (parent) {
          parent.replies.push(map.get(comment.id));
        }
      } else {
        roots.push(map.get(comment.id));
      }
    });


    res.status(200).json(roots);
  } catch (error) {
    console.error('Error on get comments:', error);
    res.status(500).send('Error on get comments');
  }

  client.end;
})

app.post('/comments', verifyToken, async (req, res) => {
  const { postId, content, parent_comment_id } = req.body;

  const user_id = req.user.id

  const insertQuery = `INSERT INTO "comments" (post_id, content,parent_comment_id ,user_id) VALUES($1, $2, $3,$4) RETURNING *`;

  try {
    const result = await client.query(insertQuery, [postId, content, parent_comment_id, user_id]);
    console.log(result.rows);

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error on add post:', err);
    res.status(500).send('Error on add post');
  }
})

app.post('/votes', verifyToken, async (req, res) => {
  const { entity_id, entity_type, vote_type } = req.body;

  const user_id = req.user.id

  const insertQuery = `INSERT INTO "votes" (user_id, entity_id, entity_type, vote_type)
    VALUES($1, $2, $3, $4)
    ON CONFLICT (user_id, entity_id, entity_type)
    DO UPDATE SET vote_type = EXCLUDED.vote_type
    RETURNING *`;

  try {
    const result = await client.query(insertQuery, [user_id, entity_id, entity_type, vote_type]);
    console.log(result.rows);

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error on add post:', err);
    res.status(500).send('Error on add post');
  }
})

app.delete('/votes', verifyToken, async (req, res) => {
  const { entity_id, entity_type } = req.body;

  const user_id = req.user.id;

  const deleteQuery = `DELETE FROM "votes"
    WHERE user_id = $1 AND entity_id = $2 AND entity_type = $3
    RETURNING *`;

  try {
    const result = await client.query(deleteQuery, [user_id, entity_id, entity_type]);

    if (result.rowCount === 0) {
      return res.status(404).send('Vote not found');
    }

    console.log('Deleted vote:', result.rows);

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error on delete vote:', err);
    res.status(500).send('Error on delete vote');
  }
});
