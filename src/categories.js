// Each store has its own category tree. Map them onto one shared list so the UI can filter
// across stores. First matching rule wins; tested against the store's own category name.
const RULES = [
  ['Clothing & shoes', /vaat|kenk|shoes|asuste/i],
  ['Fruit & vegetables', /hedelm|vihann|juurek|marja|sien|yrtit|salaat/i],
  ['Meat & fish', /liha|broiler|kana|kalkkun|kala|meren|makkar|leikkeleet|kasviprote/i],
  ['Dairy, cheese & eggs', /maito|juust|muna|rasva|jogurt|tofu|kasvipohj/i],
  ['Bread & bakery', /leip|leivon|keksi|leivät/i],
  ['Ready meals & frozen', /valmisruo|pakast|eines/i],
  ['Pantry & other food', /elintarvik|pasta|riisi|nuudel|mauste|öljy|kastik|säilyke|kuivat|leivonta|aamupal|mysli|muro|jauho/i],
  ['Sweets & snacks', /makei|karkk|suklaa|snack|napost|sipsi|pähkin/i],
  ['Drinks', /juom|kahvi|\bteet?\b|mehu|virvoit|olut|siideri|alkoholi/i],
  ['Beauty & health', /kauneus|terveys|hyvinvoin|kosmet|hygien|itsehoit|urheiluravint|apteek/i],
  ['Cleaning & household', /kodinhoit|siivo|pesu|säilytys|taloustarv|paperi/i],
  ['Kids & toys', /lapsi|lapse|lelu|vauva|miny/i],
  ['Pets', /lemmik|koira|kissa/i],
  ['Home & decor', /sisustus|keitti|kattaus|kukat|koti|juhlatarv/i],
  ['Electronics', /tekniik|elektron|kodinkon/i],
  ['Garden, car & DIY', /piha|puutarh|autoil|kunnostus|työkal|rauta/i],
  ['Leisure & crafts', /vapaa-aika|askartel|käsityö|toimisto|urheil|retkeil/i],
];

// Clothing stores: tested against the product type (e.g. XXL's "miesten collegehousut").
// Order matters: base layers before trousers ("kerrastohousut"), trousers before tops
// ("collegehousut").
const CLOTHING_RULES = [
  ['Shoes', /kenk|kengä|sandaal|saappa|tossu|lenkkar|tennar|jalkine|sneaker|varsikeng|shoe|boot|sandal|slipper|sneaker|trainer|\bclog/i],
  ['Socks', /sukat|sukka|sukkahous|\bsocks?\b/i],
  ['Underwear & base layers', /alus|bokser|kerrasto|rintaliiv|urheiluliiv|aluspaita|alushous|yöasu|pyjama|underwear|lingerie|\bbra\b|sports ?bra|briefs|boxer|sleepwear|nightwear|\bthong/i],
  ['Swimwear', /uima|bikini|swim/i],
  ['Trousers & shorts', /housu|trikoo|shortsi|legging|farku|caprit|pitkikse|trouser|\bpants?\b|\bpnt\b|jeans|denim|\bshorts?\b|jogger|tight|legging|\bcapri/i],
  ['Dresses & skirts', /mekko|hame|dress|skirt|jumpsuit/i],
  ['Jackets & outerwear', /takki|anorak|parka|liivi|haalari|toppapuku|ulkoilupuku|poncho|jacket|\bjkt\b|coat|blazer|waistcoat|vest|parka|anorak|\bshell\b|insulat|\bdown\b|softshell|\bgilet/i],
  ['Hoodies & knitwear', /huppari|college|neule|fleece|villapaita|pusero|cardigan|hoodie|sweat|knit|pullover|jumper|\bhood|\bhoody|\bcrew\b|half zip|1\/4 zip|full zip|\bfz\b|midlayer/i],
  ['Tops & shirts', /paita|toppi|topit|yläosa|body|pikee|poolo|pusero|kauluspaita|singlet|tank|t-shirt|shirt|\btops?\b|blouse|polo|\btee\b|\bss\b|\bls\b|singlet|\btank|base ?layer/i],
  ['Hats, gloves & scarves', /pipo|lippis|hattu|myssy|käsine|hanska|lapas|sormikk|kaulahuiv|huivi|kaulaliina|tuubihuiv|otsanauha|balaclava|\bhats?\b|\bcaps?\b|beanie|glove|mitten|\bmitt\b|scarf|neck ?gaiter|neck ?warmer|headband|buff/i],
  ['Bags & accessories', /laukk|reppu|vyö|koru|kaulakoru|korvakoru|rannekoru|aurinkolas|lompak|hiuskoru|hiuspant|asuste|\bbags?\b|belt|jewel|earring|necklace|sunglass|wallet|accessor|accessoir/i],
];

// Electronics stores: tested against "<store category> <product name>", e.g. Verkkokauppa's
// "Kodinkoneet > Uunit ja liedet > Keittotasot > Induktiotasot Bosch …". Some groups appear twice
// on purpose so the order resolves overlaps (TV & audio vs headphones; large vs small appliances).
const ELECTRONICS_RULES = [
  // Musical instruments (Verkkokauppa files them under "Kuva ja ääni > Musiikki").
  ['Other electronics', /musiikki > (soittimet|vahvistimet soittimille|musiikkitarvik)|sähkökitar|akustinen kitara|digitaalipiano|rumpusetti/i],
  ['Gaming', /pelaaminen|^gaming|pelikonsol|pelitarvik|pelituol|pelikaluste|playstation|xbox|nintendo|\bps5\b|steam deck/i],
  ['Personal care', /kauneus|hampai|suun hoito|hiusten|parranaj|ihokarv|ihon ja|hieronta|beauty|terveys ja hyvinvointi|sähköhammasharj|epilaat|hiustenkuivaa|trimmer|shaver/i],
  ['Smart home & networking', /smart home|> älykoti|älykodin|älykoti ja|verkkolait|reititin|reitittim|verkkolaitteet|mesh-|mobiililaajakaista|valvontakamer|turvakamer|turvallisuus ja valvonta|kodin turvallisuus|älyvalaist|älypistorasia|älylamppu|\brouter/i],
  ['Photo & video', /> ?kamerat|kamerat ja dron|valokuva|\bdron|objektiiv|actionkamer|gopro|videokamer|järjestelmäkamer|kompaktikamer|\bcamera\b/i],
  ['TV & audio', /televisi|tv-paket|projektor|blu-ray|mediatoist/i],
  ['Headphones & speakers', /kuulok|kaiutin|kaiuttim|headphone|earbud|earphone|speaker|soundbar|hifi|äänentoisto|mikrofon|vahvistin|audio ja hifi/i],
  ['TV & audio', /\btv\b|levysoitin|audio|kuva ja ääni/i],
  ['Phones & tablets', /puhelin|puhelim|tablet(?!it\b)|tabletit ja|> tabletit|älykell|puettav|smartwatch|iphone|ipad|laturi|powerbank|varavirta|autoon/i],
  ['Monitors & accessories', /näytöt|näyttö\b|pelinäyt|monitor|näppäim|hiiret|\bhiiri|keyboard|mouse|webkamer|tulost|printer|kiintolevy|tallentaminen|muistikort|tietokonetarvik|oheislait|tietokonelauk|komponent|toimisto ja työhuone|kaapelit ja adapter|kaapelit ja liitettävyys|virtalähde|näytönohjain/i],
  ['Computers & laptops', /tietokone|kannettav|läppär|laptop|macbook|chromebook|pöytäkone|tietotekniik|ohjelmist|\bimac\b|mac mini/i],
  ['Home appliances (large)', /jääkaap|pakastin|kylmälait|kylmäkaap|astianpesu|pyykinpesu|kuivausrump|kuivauskaap|pesutorni|uunit|kalusteuun|liedet|\bliesi|keittotaso|induktiotaso|liesituulet|viinikaap|mikroaaltouun|norema|keittiömallisarj|washing machine|dishwasher|fridge|freezer/i],
  ['Small appliances & kitchen', /pienkone|kahvi|espresso|vedenkeit|leivänpaahd|airfryer|ilmafriteer|tehosekoit|yleiskone|sekoitin|imuri|pölynimur|siivous|silitys|höyrysti|vaatehuol|ilmanpuhdist|ilmankostut|ilmastointi|tuuletin|lämmitin|sisäilma|grilli|grillaus|ruoanlaitto|paistaminen|keittiötarvik|keittiövälin|vesi ja juomat|keittiön|coffee|kettle|toaster|blender|vacuum/i],
  ['Home appliances (large)', /kodinkone|appliance/i],
];

// Fast-food chains: tested against the offer's label and name (e.g. "Lounastarjous Lounas tulille").
const FOOD_RULES = [
  ['Lunch deals', /lounas|lunch/i],
  ['Meals & combos', /ateria|kombo|combo|meal|menu|\+/i],
  // Chicken and burgers before vegetarian: "juustokasvisateria"-style names are meals anyway.
  ['Chicken', /kana|chicken|nugget|wings|siive/i],
  ['Burgers', /hampurilai|burger|whopper|cheese|juusto|pihvi/i],
  ['Vegetarian', /kasvis|veke|vegaan|vegan|veggie|plant/i],
  ['Desserts & ice cream', /jäätelö|pehmy|piirakka|pirtelö|shake|sundae|jälkiruo|dessert|donitsi|munkki|kakku/i],
  ['Sides & dips', /ranskalai|fries|dippi|kastike|majoneesi|dip\b|sauce|muki|lohko/i],
  ['Drinks', /juoma|kahvi|coffee|red bull|limu|soda|mehu|drink/i],
  ['Wraps & subs', /wrap|tortilla|sub\b|patonki|sandwich|leipä/i],
];

export const isClothing = (text) => CLOTHING_RULES.some(([, re]) => re.test(text ?? ''));

// `segment` picks the rule set (groceries, clothing or electronics) and its fallback group.
const SEGMENT_RULES = {
  groceries: [RULES, 'Other'],
  clothing: [CLOTHING_RULES, 'Other clothing'],
  electronics: [ELECTRONICS_RULES, 'Other electronics'],
  food: [FOOD_RULES, 'Other offers'],
};

export function unifyCategory(original, segment = 'groceries') {
  const [rules, fallback] = SEGMENT_RULES[segment] ?? SEGMENT_RULES.groceries;
  // Already one of our group names (e.g. chosen by the campaign analyst): keep it.
  if (original === fallback || rules.some(([name]) => name === original)) return original;
  for (const [name, re] of rules) if (re.test(original ?? '')) return name;
  return fallback;
}
