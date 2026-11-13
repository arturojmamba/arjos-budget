/**
 * Smart categorisation: a built-in directory of well-known UK merchants and
 * tell-tale words, used when no rule and no past transaction says otherwise.
 * It runs entirely offline.
 *
 * Each entry lists category names in order of preference; the first one that
 * exists in your categories is used (so fuel goes to "Car" if you have it,
 * otherwise "Transport"). Nothing is suggested if none of them exist.
 *
 * Patterns are matched as whole words against the description, lower-cased,
 * with punctuation turned into spaces ("McDONALD'S 1234" → "mcdonald s 1234").
 * Order matters: the first matching entry wins, so specific entries
 * ("amazon prime", "uber eats", "tesco petrol") come before broad ones.
 */
import type { DB } from '../db.ts';

type Entry = { cats: string[]; words: string[]; income?: boolean };

const EATING = ['Eating Out', 'Restaurants', 'Takeaway', 'Food & Drink'];
const GROCERIES = ['Groceries', 'Food'];
const TRANSPORT = ['Transport', 'Travel'];
const FUEL = ['Car', 'Fuel', 'Transport'];
const CLOTHES = ['Clothing', 'Clothes', 'Shopping'];
const SHOPPING = ['Shopping'];
const FUN = ['Entertainment'];
const GAMING = ['Gaming', 'Entertainment'];
const SUBS = ['Subscriptions'];
const BILLS = ['Bills & Utilities', 'Bills', 'Utilities'];
const PHONE = ['Phone & Internet', 'Bills & Utilities', 'Bills'];
const INSURANCE = ['Insurance', 'Bills & Utilities', 'Bills'];
const HOUSING = ['Rent / Housing', 'Rent', 'Housing'];
const HEALTH = ['Health & Fitness', 'Health'];
const CARE = ['Personal Care', 'Health & Fitness'];
const TRAVEL = ['Travel', 'Holidays'];
const EDUCATION = ['Education'];
const FEES = ['Interest & Fees', 'Fees'];
const GIFTS = ['Gifts'];
const CHARITY = ['Charity', 'Donations', 'Gifts'];

const ENTRIES: Entry[] = [
  // --- Never guess: banks and payment firms that share a shop's name (card repayments, transfers).
  { cats: [], words: ['tesco bank', 'sainsburys bank', 'sainsbury s bank', 'm&s bank', 'john lewis finance', 'argos card', 'next pay', 'capital one', 'klarna', 'clearpay', 'paypal pypl payin', 'payin3', 'zilch'] },

  // --- Specific cases first: same brand, different kind of spending.
  { cats: BILLS, words: ['shell energy', 'bp energy'] },
  { cats: SUBS, words: ['uber one', 'deliveroo plus', 'amazon prime', 'prime video', 'amzn digital', 'amazon music', 'kindle unlimited', 'audible'] },
  { cats: GROCERIES, words: ['amazon fresh', 'm&s simply food', 'm s simply food', 'marks spencer food', 'm&s food', 'hello fresh', 'hellofresh', 'gousto', 'mindful chef'] },
  { cats: EATING, words: ['uber eats', 'ubereats', 'deliveroo', 'just eat', 'justeat'] },
  { cats: FUEL, words: ['tesco petrol', 'tesco pfs', 'sainsburys petrol', 'sainsbury s petrol', 'asda petrol', 'morrisons petrol', 'morrisons fuel'] },
  { cats: PHONE, words: ['tesco mobile', 'sky mobile', 'virgin mobile'] },
  { cats: HEALTH, words: ['lloyds pharmacy', 'boots pharmacy', 'boots opticians', 'superdrug pharmacy', 'well pharmacy'] },
  { cats: SUBS, words: ['apple com bill', 'itunes com bill', 'apple music', 'icloud', 'google storage', 'google one', 'youtube premium', 'microsoft 365', 'office 365', 'xbox game pass', 'playstation plus', 'nintendo switch online'] },

  // --- Eating out.
  { cats: EATING, words: [
    'mcdonald', 'mcdonalds', 'burger king', 'kfc', 'nandos', 'nando s', 'five guys', 'wagamama', 'pizza express', 'pizzaexpress', 'pizza hut',
    'dominos', 'domino s', 'papa johns', 'papa john s', 'greggs', 'pret', 'pret a manger', 'costa', 'costa coffee', 'starbucks', 'caffe nero', 'cafe nero',
    'leon restaurants', 'itsu', 'wasabi', 'yo sushi', 'tortilla', 'chipotle', 'subway', 'taco bell', 'wingstop', 'popeyes', 'tim hortons', 'krispy kreme',
    'gails', 'gail s', 'black sheep coffee', 'joe the juice', 'honest burgers', 'byron', 'zizzi', 'ask italian', 'prezzo', 'franco manca', 'cote brasserie',
    'dishoom', 'hawksmoor', 'tgi fridays', 'frankie benny', 'toby carvery', 'harvester', 'beefeater', 'miller carter', 'wetherspoon', 'wetherspoons',
    'all bar one', 'slug and lettuce', 'brewdog', 'bill s restaurant', 'gbk', 'gourmet burger', 'shake shack', 'chopstix', 'boost juice', 'muffin break', 'blank street', 'aramark', 'simmons', 'kasa and kin', 'bars',
    'restaurant', 'cafe', 'coffee', 'bakery', 'pizzeria', 'pizza', 'sushi', 'kebab', 'takeaway', 'bistro', 'brasserie', 'diner', 'burger', 'noodle', 'ramen', 'tapas', 'pub', 'canteen',
  ] },

  // --- Groceries.
  { cats: GROCERIES, words: [
    'tesco', 'sainsburys', 'sainsbury s', 'sainsbury', 'asda', 'morrisons', 'aldi', 'lidl', 'waitrose', 'co op', 'coop', 'co operative', 'iceland', 'ocado',
    'farmfoods', 'budgens', 'spar', 'londis', 'nisa', 'costcutter', 'one stop', 'whole foods', 'planet organic', 'booths', 'getir', 'gopuff', 'zapp',
    'abel cole', 'riverford', 'milk more', 'costco', 'supermarket', 'grocer', 'grocery', 'butcher', 'greengrocer', 'off licence',
  ] },

  // --- Driving: fuel, charging, parking, upkeep (before generic transport).
  { cats: FUEL, words: [
    'shell', 'bp', 'esso', 'texaco', 'gulf', 'jet petrol', 'murco', 'petrol', 'fuel', 'filling station', 'service station', 'halfords', 'kwik fit',
    'ats euromaster', 'the aa', 'dvla', 'vehicle tax', 'car wash', 'rac motoring', 'aa membership', 'tesla supercharger', 'pod point', 'bp pulse', 'ionity', 'instavolt',
    'dart charge', 'congestion charge', 'ulez', 'ringgo', 'paybyphone', 'justpark', 'ncp', 'apcoa', 'q park', 'car park', 'parking', 'mipermit',
  ] },

  // --- Transport.
  { cats: TRANSPORT, words: [
    'tfl', 'transport for london', 'oyster', 'trainline', 'national rail', 'lner', 'avanti', 'gwr', 'great western railway', 'southern railway', 'southeastern',
    'thameslink', 'northern rail', 'scotrail', 'transpennine', 'c2c', 'chiltern railways', 'crosscountry', 'greater anglia', 'merseyrail', 'elizabeth line',
    'uber', 'bolt', 'free now', 'freenow', 'addison lee', 'lime', 'voi', 'santander cycles', 'stagecoach', 'arriva', 'first bus', 'national express',
    'megabus', 'flixbus', 'metrolink', 'taxi', 'cabs', 'railway', 'rail', 'bus',
  ] },

  // --- Travel.
  { cats: TRAVEL, words: [
    'easyjet', 'ryanair', 'british airways', 'ba com', 'jet2', 'wizz air', 'tui', 'virgin atlantic', 'emirates', 'klm', 'air france', 'lufthansa',
    'turkish airlines', 'qatar airways', 'booking com', 'airbnb', 'expedia', 'hotels com', 'premier inn', 'travelodge', 'hilton', 'marriott', 'ibis',
    'holiday inn', 'hostelworld', 'airalo', 'trip com', 'eurostar', 'heathrow', 'gatwick', 'stansted', 'world duty free', 'duty free', 'hotel', 'airways', 'airlines',
  ] },

  // --- Clothes, then general shopping.
  { cats: CLOTHES, words: [
    'zara', 'h&m', 'h m', 'primark', 'next retail', 'next plc', 'next directory', 'asos', 'uniqlo', 'river island', 'new look', 'mango', 'cos', 'arket',
    'jd sports', 'sports direct', 'nike', 'adidas', 'puma', 'foot locker', 'schuh', 'office shoes', 'clarks', 'tk maxx', 'tkmaxx', 'matalan', 'boohoo',
    'prettylittlething', 'shein', 'zalando', 'end clothing', 'fat face', 'white stuff', 'superdry', 'levi', 'levis', 'gap', 'abercrombie', 'hollister',
    'urban outfitters', 'weekday', 'pull bear', 'bershka', 'stradivarius', 'massimo dutti', 'ted baker', 'reiss', 'allsaints', 'all saints',
    'gymshark', 'lululemon', 'vinted', 'depop', 'mountain warehouse', 'north face', 'the north face', 'snipes', 'flannels',
  ] },
  { cats: SHOPPING, words: [
    'amazon', 'amzn', 'argos', 'currys', 'ikea', 'b&q', 'wickes', 'screwfix', 'toolstation', 'homebase', 'dunelm', 'the range', 'hobbycraft', 'wilko',
    'poundland', 'b&m', 'home bargains', 'the works', 'whsmith', 'wh smith', 'waterstones', 'etsy', 'ebay', 'apple store', 'very co uk', 'ao com',
    'john lewis', 'selfridges', 'harrods', 'house of fraser', 'lakeland', 'marks spencer', 'm&s', 'temu', 'aliexpress', 'robert dyas', 'smyths',
    'the entertainer', 'pandora', 'h samuel', 'ernest jones', 'game digital', 'cex', 'shop', 'store', 'stores',
  ] },

  // --- Entertainment and gaming.
  { cats: GAMING, words: ['supercell', 'steam', 'steampowered', 'playstation', 'psn', 'sony interactive', 'xbox', 'nintendo', 'epic games', 'riot games', 'blizzard', 'ea games', 'roblox'] },
  { cats: FUN, words: [
    'cineworld', 'odeon', 'vue', 'picturehouse', 'everyman', 'ticketmaster', 'see tickets', 'eventbrite', 'dice fm', 'skiddle', 'axs', 'theatre',
    'cinema', 'all star lanes', 'hollywood bowl', 'puttshack', 'flight club', 'bowling', 'museum', 'gallery', 'zoo', 'theme park', 'merlin',
  ] },

  // --- Subscriptions.
  { cats: SUBS, words: [
    'netflix', 'spotify', 'youtube', 'disney plus', 'disneyplus', 'now tv', 'nowtv', 'dazn', 'deezer', 'tidal', 'paramount', 'crunchyroll', 'patreon', 'chatgpt',
    'openai', 'anthropic', 'claude ai', 'notion', 'dropbox', 'adobe', 'canva', 'duolingo', 'headspace', 'calm com', 'strava', 'linkedin premium', 'substack',
  ] },

  // --- Bills, phone and broadband, insurance, housing.
  { cats: BILLS, words: [
    'british gas', 'octopus energy', 'edf', 'eon', 'e on', 'e on next', 'ovo', 'scottish power', 'so energy', 'shell energy', 'thames water', 'severn trent',
    'anglian water', 'united utilities', 'yorkshire water', 'southern water', 'affinity water', 'welsh water', 'council tax', 'tv licence', 'tv licensing',
  ] },
  { cats: PHONE, words: [
    'bt group', 'british telecom', 'bt broadband', 'virgin media', 'sky digital', 'sky uk', 'talktalk', 'plusnet', 'hyperoptic', 'community fibre',
    'vodafone', 'o2', 'ee limited', 'three co uk', 'hutchison 3g', 'giffgaff', 'smarty', 'lebara', 'lycamobile', 'id mobile', 'voxi', 'broadband',
  ] },
  { cats: INSURANCE, words: ['admiral', 'direct line', 'aviva', 'churchill', 'hastings direct', 'esure', 'lv insurance', 'axa', 'zurich', 'simply business', 'insurance'] },
  { cats: HOUSING, words: ['rent', 'openrent', 'homelet', 'lettings', 'letting agent', 'estate agent', 'mortgage', 'ground rent', 'service charge'] },

  // --- Health, fitness and personal care.
  { cats: HEALTH, words: [
    'puregym', 'pure gym', 'the gym group', 'gym group', 'david lloyd', 'virgin active', 'nuffield', 'anytime fitness', 'better leisure', 'fitness first',
    'third space', '1rebel', 'f45', 'classpass', 'peloton', 'gym', 'pharmacy', 'chemist', 'dentist', 'dental', 'optician', 'opticians', 'specsavers',
    'vision express', 'bupa', 'physio', 'clinic', 'nhs',
  ] },
  { cats: CARE, words: ['boots', 'superdrug', 'the body shop', 'lush', 'sephora', 'space nk', 'treatwell', 'fresha', 'barber', 'barbers', 'hairdresser', 'salon', 'nails', 'beauty', 'spa'] },

  // --- Education, gifts, charity, fees.
  { cats: EDUCATION, words: ['udemy', 'coursera', 'skillshare', 'masterclass', 'open university', 'university', 'college', 'tuition'] },
  { cats: GIFTS, words: ['moonpig', 'funky pigeon', 'card factory', 'interflora', 'bloom wild', 'clintons', 'florist'] },
  { cats: CHARITY, words: ['justgiving', 'gofundme', 'charity', 'donation', 'cancer research', 'british heart foundation', 'oxfam', 'red cross'] },
  { cats: FEES, words: ['overdraft interest', 'interest charged', 'interest charge', 'late payment fee', 'late fee', 'annual fee', 'monthly fee', 'account fee', 'non sterling', 'foreign transaction fee'] },

  // --- Income (money coming in only).
  { cats: ['Salary'], words: ['salary', 'payroll', 'wages'], income: true },
  { cats: ['Interest'], words: ['interest paid', 'interest earned', 'gross interest', 'credit interest', 'interest'], income: true },
  { cats: ['Other Income'], words: ['hmrc', 'tax refund', 'cashback'], income: true },
];

/** "McDONALD'S 1234 LONDON" → "mcdonald s 1234 london"; keeps & so "h&m" and "b&q" survive. */
export function smartText(description: string): string {
  return description.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim();
}

const COMPILED = ENTRIES.map((e) => ({
  ...e,
  re: new RegExp(`(?:^| )(?:${e.words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?= |$)`),
}));

export interface SmartMatch { categoryId: number; categoryName: string; kind: 'expense' | 'income'; matched: string }

/** Which built-in entry matches a description, before looking at your categories. */
export function smartEntry(description: string, amount: number): { cats: string[]; income: boolean; matched: string } | null {
  const text = smartText(description);
  if (!text) return null;
  // Money coming in is checked against income first ("NHS SALARY" is pay, not a pharmacy refund).
  const order = amount > 0 ? [...COMPILED.filter((e) => e.income), ...COMPILED.filter((e) => !e.income)] : COMPILED.filter((e) => !e.income);
  for (const e of order) {
    const m = e.re.exec(text);
    if (m) return e.cats.length ? { cats: e.cats, income: !!e.income, matched: m[0].trim() } : null;
  }
  return null;
}

/** Suggest one of your categories for a description, or null. Expense categories also cover refunds. */
export function smartCategory(db: DB, description: string, amount: number): SmartMatch | null {
  const hit = smartEntry(description, amount);
  if (!hit) return null;
  const kind = hit.income ? 'income' : 'expense';
  const cats = db.prepare('SELECT id, name FROM categories WHERE kind = ? AND archived = 0').all(kind) as { id: number; name: string }[];
  for (const want of hit.cats) {
    const c = cats.find((x) => x.name.toLowerCase() === want.toLowerCase());
    if (c) return { categoryId: c.id, categoryName: c.name, kind, matched: hit.matched };
  }
  return null;
}
