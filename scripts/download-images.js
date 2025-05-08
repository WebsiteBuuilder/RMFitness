const https = require('https');
const fs = require('fs');
const path = require('path');

const images = [
  {
    url: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48',
    name: 'hero-bg.jpg',
    params: '?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8M3x8amFtYWljYXxlbnwwfHwwfHx8MA%3D%3D&auto=format&fit=crop&w=1200&q=60'
  },
  {
    url: 'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b',
    name: 'trainer.jpg',
    params: '?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8NXx8Zml0bmVzcyUyMHRyYWluZXJ8ZW58MHx8MHx8fDA%3D&auto=format&fit=crop&w=600&q=60'
  },
  {
    url: 'https://images.unsplash.com/photo-1599058917765-a780eda07a3e',
    name: 'personal-training.jpg',
    params: '?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8NHx8cGVyc29uYWwlMjB0cmFpbmluZ3xlbnwwfHwwfHx8MA%3D%3D&auto=format&fit=crop&w=600&q=60'
  },
  {
    url: 'https://images.unsplash.com/photo-1518611012118-696072aa579a',
    name: 'nutrition.jpg',
    params: '?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8Mnx8bnV0cml0aW9ufGVufDB8fDB8fHww&auto=format&fit=crop&w=600&q=60'
  },
  {
    url: 'https://images.unsplash.com/photo-1518459031867-a89b944bffe4',
    name: 'group-training.jpg',
    params: '?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8Mnx8Z3JvdXAlMjBmaXRuZXNzfGVufDB8fDB8fHww&auto=format&fit=crop&w=600&q=60'
  },
  {
    url: 'https://images.unsplash.com/photo-1583454110551-21f2fa2afe61',
    name: 'gallery-1.jpg',
    params: '?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8MTF8fGZpdG5lc3MlMjB0cmFpbmluZ3xlbnwwfHwwfHx8MA%3D%3D&auto=format&fit=crop&w=600&q=60'
  },
  {
    url: 'https://images.unsplash.com/photo-1574680178050-55c6a6a96e0a',
    name: 'gallery-2.jpg',
    params: '?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8M3x8ZmlubmVzcyUyMGphbWFpY2F8ZW58MHx8MHx8fDA%3D&auto=format&fit=crop&w=600&q=60'
  },
  {
    url: 'https://images.unsplash.com/photo-1551763337-ff6a8d6df8a3',
    name: 'gallery-3.jpg',
    params: '?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8NHx8ZmlubmVzcyUyMGphbWFpY2F8ZW58MHx8MHx8fDA%3D&auto=format&fit=crop&w=600&q=60'
  },
  {
    url: 'https://images.unsplash.com/photo-1594381898411-846e7d193883',
    name: 'gallery-4.jpg',
    params: '?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8MTd8fGZpdG5lc3MlMjB0cmFpbmluZ3xlbnwwfHwwfHx8MA%3D%3D&auto=format&fit=crop&w=600&q=60'
  },
  {
    url: 'https://images.unsplash.com/photo-1599058917212-d750089bc07e',
    name: 'gallery-5.jpg',
    params: '?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8N3x8cGVyc29uYWwlMjB0cmFpbmluZ3xlbnwwfHwwfHx8MA%3D%3D&auto=format&fit=crop&w=600&q=60'
  },
  {
    url: 'https://images.unsplash.com/photo-1605296867304-46d5465a13f1',
    name: 'gallery-6.jpg',
    params: '?ixlib=rb-4.0.3&ixid=M3wxMjA3fDB8MHxzZWFyY2h8MTZ8fGZpdG5lc3MlMjB0cmFpbmluZ3xlbnwwfHwwfHx8MA%3D%3D&auto=format&fit=crop&w=600&q=60'
  }
];

const imagesDir = path.join(__dirname, '../public/images');

// Create images directory if it doesn't exist
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

// Download images
images.forEach(image => {
  const filePath = path.join(imagesDir, image.name);
  const file = fs.createWriteStream(filePath);

  https.get(`${image.url}${image.params}`, response => {
    response.pipe(file);
    file.on('finish', () => {
      file.close();
      console.log(`Downloaded: ${image.name}`);
    });
  }).on('error', err => {
    fs.unlink(filePath, () => {});
    console.error(`Error downloading ${image.name}:`, err.message);
  });
}); 