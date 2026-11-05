import { buildApiError, userError } from '../utils/apiError';

const PROXY_URL = '/api';

const FETCH_FAILED = "Burrow couldn't load your transactions.";
const ADD_FAILED = "Burrow couldn't save those transactions.";
const DELETE_FAILED = "Burrow couldn't delete those transactions.";
const CLEAR_FAILED = "Burrow couldn't clear your transactions.";

/** Builds an Error with fixed `message` copy, keeping `status` (and the structured fields). */
async function failFrom(response, message) {
  const body = await response.json().catch(() => ({}));
  const err = buildApiError(response, body);
  err.message = message;
  err.userFacing = true;
  return err;
}

const transactionsService = {
  async fetchTransactions() {
    let response;
    try {
      response = await fetch(`${PROXY_URL}/transactions`);
    } catch (cause) {
      throw Object.assign(userError(FETCH_FAILED), { cause });
    }
    if (!response.ok) throw await failFrom(response, FETCH_FAILED);
    return response.json();
  },

  async addTransactions(transactions) {
    let response;
    try {
      response = await fetch(`${PROXY_URL}/transactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ records: transactions }),
      });
    } catch (cause) {
      throw Object.assign(userError(ADD_FAILED), { cause });
    }
    if (!response.ok) throw await failFrom(response, ADD_FAILED);
    return response.json();
  },

  async deleteTransactions(recordIds) {
    let response;
    try {
      response = await fetch(`${PROXY_URL}/transactions`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ recordIds }),
      });
    } catch (cause) {
      throw Object.assign(userError(DELETE_FAILED), { cause });
    }
    if (!response.ok) throw await failFrom(response, DELETE_FAILED);
    return true;
  },

  async clearTransactions() {
    try {
      const transactions = await this.fetchTransactions();
      const recordIds = transactions.map((t) => t.id);
      if (recordIds.length > 0) {
        await this.deleteTransactions(recordIds);
      }
      return true;
    } catch (cause) {
      throw Object.assign(userError(CLEAR_FAILED), { cause, status: cause?.status });
    }
  },
};

export { transactionsService };
