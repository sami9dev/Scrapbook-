import fs from 'fs';
import path from 'path';

const datasetPath = path.resolve('src/data/tv-dataset.json');
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

const uhdItems = [
  {
    title: 'The Vampire Diaries',
    url: 'https://uhdmovies.my/download-the-vampire-diaries-season-01-08-2009-2017-english-audio-1080p-10bit-1080p-x264-remux-web-dl-esubs/',
    format: 'Series',
    genre: 'Drama, Fantasy, Horror, Romance',
    country: 'US',
    language: 'English',
    platform: 'UHDMovies',
  },
  {
    title: 'Red Queen aka Reina Roja',
    url: 'https://uhdmovies.my/download-red-queen-reina-roja-2024-season-1-hindi-1080p/',
    format: 'Series',
    genre: 'Thriller, Action, Crime',
    country: 'Spain',
    language: 'Hindi, Spanish, English',
    platform: 'UHDMovies',
  },
  {
    title: 'I Would Rather Die',
    url: 'https://uhdmovies.my/download-i-would-rather-die-2026-multi-audio-hindi-english-spanish-1080p-x264-web-dl-esubs/',
    format: 'Movie',
    genre: 'Drama, Thriller',
    country: 'US',
    language: 'Hindi, English, Spanish',
    platform: 'UHDMovies',
  },
  {
    title: 'Doing Life',
    url: 'https://uhdmovies.my/download-doing-life-2026-dual-audio-hindi-english-1080p-x264-web-dl-esubs/',
    format: 'Movie',
    genre: 'Drama, Comedy',
    country: 'US',
    language: 'Hindi, English',
    platform: 'UHDMovies',
  },
  {
    title: 'The End of Oak Street',
    url: 'https://uhdmovies.my/download-the-end-of-oak-street-2026-dual-audio-hindi-english-2160p-4k-dv-hdr-4k-sdr-1080p-web-dl-esubs/',
    format: 'Movie',
    genre: 'Horror, Mystery, Thriller',
    country: 'US',
    language: 'Hindi, English',
    platform: 'UHDMovies',
  },
  {
    title: 'East of Eden',
    url: 'https://uhdmovies.my/download-east-of-eden-2026-dual-audio-hindi-english-tamil-telugu-1080p-x264-web-dl-esubs/',
    format: 'Movie',
    genre: 'Drama, Classic',
    country: 'US',
    language: 'Hindi, English, Tamil, Telugu',
    platform: 'UHDMovies',
  },
  {
    title: 'Medusa',
    url: 'https://uhdmovies.my/download-medusa-2025-season-1-multi-audio-hindi-english-spanish-1080p-x264-hevc-web-dl-esubs/',
    format: 'Series',
    genre: 'Crime, Drama, Mystery',
    country: 'US/Spain',
    language: 'Hindi, English, Spanish',
    platform: 'UHDMovies',
  },
  {
    title: 'Hokum',
    url: 'https://uhdmovies.my/download-hokum-2026-dual-audio-hindi-english-2160p-4k-1080p-10bit-hevc-blu-ray-esubs/',
    format: 'Movie',
    genre: 'Comedy, Drama',
    country: 'US',
    language: 'Hindi, English',
    platform: 'UHDMovies',
  },
  {
    title: 'Death of a Unicorn',
    url: 'https://uhdmovies.my/download-death-of-a-unicorn-2025-dual-audio-hindi-english-2160p-4k-1080p-10bit-hevc-blu-ray-esubs/',
    format: 'Movie',
    genre: 'Comedy, Fantasy, Horror',
    country: 'US',
    language: 'Hindi, English',
    platform: 'UHDMovies',
  },
  {
    title: 'Lanterns',
    url: 'https://uhdmovies.my/download-lanterns-2026-season-01-dual-audio-hindi-english-2160p-4k-dv-hdr-4k-sdr-1080p-x264-web-dl-esubs/',
    format: 'Series',
    genre: 'Action, Sci-Fi, Mystery',
    country: 'US',
    language: 'Hindi, English',
    platform: 'UHDMovies',
  },
  {
    title: 'The Final Problem',
    url: 'https://uhdmovies.my/download-the-final-problem-2026-dual-audio-hindi-english-tamil-telugu-spanish-1080p-x264-web-dl-esubs/',
    format: 'Movie',
    genre: 'Crime, Mystery, Thriller',
    country: 'US',
    language: 'Hindi, English, Tamil, Telugu, Spanish',
    platform: 'UHDMovies',
  },
  {
    title: 'A Different World',
    url: 'https://uhdmovies.my/download-a-different-world-2026-dual-audio-hindi-english-1080p-x264-hevc-hdr-dovi-web-dl-esubs/',
    format: 'Movie',
    genre: 'Drama, Sci-Fi',
    country: 'US',
    language: 'Hindi, English',
    platform: 'UHDMovies',
  },
  {
    title: 'UNABOMBER',
    url: 'https://uhdmovies.my/download-unabomber-2026-dual-audio-hindi-english-1080p-x264-web-dl-esubs/',
    format: 'Movie',
    genre: 'Biography, Crime, Drama',
    country: 'US',
    language: 'Hindi, English',
    platform: 'UHDMovies',
  },
];

let added = 0;
for (const item of uhdItems) {
  const exists = dataset.some(
    (d) =>
      (d.platform === 'UHDMovies' && d.title.toLowerCase() === item.title.toLowerCase()) ||
      (d.url && d.url === item.url)
  );
  if (!exists) {
    dataset.push({
      rank: dataset.length + 1,
      ...item,
    });
    added++;
  }
}

fs.writeFileSync(datasetPath, JSON.stringify(dataset, null, 2), 'utf8');
console.log(`Added ${added} UHDMovies titles to tv-dataset.json. Total count: ${dataset.length}`);
