const fs = require('fs');
const path = require('path');

let cachedFaqString = null;

function getFaqContext() {
  if (cachedFaqString) return cachedFaqString;

  try {
    const faqPath = path.join(__dirname, 'faqContext.json');
    const data = fs.readFileSync(faqPath, 'utf8');
    const faqs = JSON.parse(data);
    
    if (!Array.isArray(faqs) || faqs.length === 0) {
      return "No FAQs available at the moment.";
    }

    cachedFaqString = faqs.map(faq => `[ID: ${faq.id} | TOPIC: ${faq.topic}]\nQUESTION: ${faq.question}\nANSWER: ${faq.answer}`).join('\n---\n');
    return cachedFaqString;
  } catch (err) {
    console.error('Error reading FAQ context:', err);
    return "Error loading FAQs.";
  }
}

module.exports = {
  getFaqContext
};
