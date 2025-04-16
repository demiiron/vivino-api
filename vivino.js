import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import minimist from 'minimist';
import fs from 'fs-extra';

puppeteer.use(StealthPlugin());

const run = async (
  name,
  countryCode = 'US',
  stateCode = '',
  minPrice,
  maxPrice,
  noPriceIncluded,
  minRatings,
  maxRatings,
  minAverage,
  maxAverage
) => {
  const validateNumber = (val) => (val !== undefined && val !== '' ? parseFloat(val) : undefined);
  minPrice = validateNumber(minPrice);
  maxPrice = validateNumber(maxPrice);
  minRatings = validateNumber(minRatings);
  maxRatings = validateNumber(maxRatings);
  minAverage = validateNumber(minAverage);
  maxAverage = validateNumber(maxAverage);

  if (countryCode.toLowerCase() === 'us' && stateCode === '') {
    stateCode = 'CA';
  }

  const BASE_URL = 'https://www.vivino.com';
  const SEARCH_PATH = '/search/wines?q=';
  const MAX_RETRIES = 5;
  const PAUSE_MULTIPLIER = 15;

  const result = { vinos: [] };

  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1920, height: 1040 },
    args: ['--start-maximized'],
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.116 Safari/537.36'
  );

  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (['document', 'xhr', 'fetch', 'script'].includes(request.resourceType())) {
      request.continue();
    } else {
      request.abort();
    }
  });

  const isShipTo = async (countryCode, stateCode) => {
    return await page.evaluate((countryCode, stateCode) => {
      return (
        window.__PRELOADED_COUNTRY_CODE__.toLowerCase() === countryCode.toLowerCase() &&
        window.__PRELOADED_STATE_CODE__.toLowerCase() === stateCode.toLowerCase()
      );
    }, countryCode, stateCode);
  };

  const setShipTo = async (countryCode, stateCode) => {
    return await page.evaluate(async (countryCode, stateCode) => {
      const csrf = document.querySelector('[name="csrf-token"]');
      if (!csrf) return false;
      const fetchResult = await fetch('https://www.vivino.com/api/ship_to/', {
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf.content,
        },
        body: JSON.stringify({ country_code: countryCode, state_code: stateCode }),
        method: 'PUT',
      });
      if (fetchResult.status !== 200) return false;
      const result = await fetchResult.json();
      return (
        result.ship_to.country_code.toLowerCase() === countryCode.toLowerCase() &&
        result.ship_to.state_code.toLowerCase() === stateCode.toLowerCase()
      );
    }, countryCode, stateCode);
  };

  const collectItems = () => {
    const numerize = (stringNumber) => {
      const str = stringNumber.replace(/[^0-9,.]+/g, '').replace(',', '.');
      return parseFloat(str);
    };

    const CARDS_SELECTOR = '.card.card-lg';
    const NAME_SELECTOR = '.wine-card__name';
    const COUNTRY_SELECTOR = '.wine-card__region [data-item-type="country"]';
    const REGION_SELECTOR = '.wine-card__region .link-color-alt-grey';
    const AVERAGE_RATING_SELECTOR = '.average__number';
    const RATINGS_SELECTOR = '.average__stars .text-micro';
    const PRICE_SELECTOR = '.wine-price-value';
    const LINK_SELECTOR = 'a';
    const THUMB_SELECTOR = 'figure';
    const THUMB_REGEX = /"(.*)"/;

    return [...document.querySelectorAll(CARDS_SELECTOR)].map((e) => ({
      name: e.querySelector(NAME_SELECTOR)?.textContent.trim(),
      link: e.querySelector(LINK_SELECTOR)?.href,
      thumb: e.querySelector(THUMB_SELECTOR)
        ? 'https:' + e.querySelector(THUMB_SELECTOR).style.backgroundImage.match(THUMB_REGEX)?.[1]
        : undefined,
      country: e.querySelector(COUNTRY_SELECTOR)?.textContent.trim(),
      region: e.querySelector(REGION_SELECTOR)?.textContent.trim(),
      average_rating: numerize(e.querySelector(AVERAGE_RATING_SELECTOR)?.textContent ?? ''),
      ratings: parseInt(
        e.querySelector(RATINGS_SELECTOR)?.textContent.replace('ratings', '').trim() ?? '0',
        10
      ),
      price: numerize(e.querySelector(PRICE_SELECTOR)?.textContent ?? ''),
    }));
  };

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

    let isDestinationRight = await isShipTo(countryCode, stateCode);
    if (!isDestinationRight) {
      const resultSetShipTo = await setShipTo(countryCode, stateCode);
      if (resultSetShipTo) {
        await page.goto(BASE_URL, { waitUntil: 'networkidle2' });
        isDestinationRight = await isShipTo(countryCode, stateCode);
        if (!isDestinationRight) {
          throw new Error('"Ship To" location could not be confirmed');
        }
      } else {
        throw new Error('"Ship To" location could not be set');
      }
    }

    let index = 1;
    let isNext = false;
    let pause = 0;
    let retryCount = 0;

    do {
      isNext = false;
      const searchUrl = `${BASE_URL}${SEARCH_PATH}${name}&start=${index}`;
      const response = await page.goto(searchUrl, { waitUntil: 'networkidle2' });

      if (response.ok()) {
        const pageItems = await page.evaluate(collectItems);
        if (pageItems.length) {
          console.log(`✔ Collected ${pageItems.length} wines from page ${index}`);
          result.vinos.push(...pageItems);
          index++;
          retryCount = 0;
          isNext = true;
        } else {
          result.status = 'DONE';
        }
      } else if (response.status() === 429 && retryCount < MAX_RETRIES) {
        retryCount++;
        pause++;
        const waitTime = pause * PAUSE_MULTIPLIER * 1000;
        console.log(`⏳ Hit rate limit, waiting ${waitTime / 1000}s (Retry ${retryCount}/${MAX_RETRIES})`);
        await page.waitForTimeout(waitTime);
        isNext = true;
      } else {
        result.status = 'HTTP_ERROR';
        result.http_status = response.status();
        result.page_index = index;
        throw new Error(`Request failed with status ${response.status()}`);
      }
    } while (isNext);

    result.vinos = result.vinos.filter((e) => {
      if (minPrice && (!e.price || e.price < minPrice)) return false;
      if (maxPrice && e.price > maxPrice) return false;
      if (minRatings && e.ratings < minRatings) return false;
      if (maxRatings && e.ratings > maxRatings) return false;
      if (minAverage && e.average_rating < minAverage) return false;
      if (maxAverage && e.average_rating > maxAverage) return false;
      return true;
    });
  } catch (error) {
    console.error('🚨 Error:', error.message);
    result.status = 'EXCEPTION';
    result.message = error.message;
  } finally {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFilename = `vivino-output-${timestamp}.json`;
    try {
      await fs.writeJson(outputFilename, result, { spaces: 2 });
      console.log(`✅ Results saved to ${outputFilename}`);
    } catch (err) {
      console.error('❌ Failed to write output file:', err.message);
    }

    await browser.close();
    console.log('🎉 Finished!');
  }
};

const args = minimist(process.argv.slice(2));
const {
  name,
  country,
  state,
  minPrice,
  maxPrice,
  noPriceIncluded,
  minRatings,
  maxRatings,
  minAverage,
  maxAverage,
} = args;

if (!name) {
  console.error('❌ Please provide a wine name using --name="example"');
  process.exit(1);
}

run(
  name,
  country,
  state,
  minPrice,
  maxPrice,
  noPriceIncluded,
  minRatings,
  maxRatings,
  minAverage,
  maxAverage
);
