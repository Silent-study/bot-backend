require('dotenv').config();
const nodemailer = require('nodemailer');

async function testEmail() {
  console.log('Starting SMTP test...');
  console.log('Host:', process.env.SMTP_HOST);
  console.log('User:', process.env.SMTP_USER);

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: process.env.SMTP_USER, // Sending to yourself
      subject: 'Silent Study SMTP Test',
      text: 'If you are reading this, your Hostinger SMTP is working perfectly!',
      html: '<b>Hostinger SMTP is working perfectly!</b>',
    });

    console.log('✅ Email sent successfully!');
    console.log('Message ID:', info.messageId);
  } catch (error) {
    console.error('❌ SMTP Error:', error);
  }
}

testEmail();
