import { createHttpRunGateway } from './run-gateway';
import { apiBaseUrl, authorizedDomains } from './config';

/**
 * The single gateway the web app uses. Draft handling is the local adapter, so configuring a
 * run works with the control plane switched off; execution goes over HTTP to the same handler
 * shape the Lambda deployment serves.
 */
export function webRunGateway() {
  return createHttpRunGateway({ storage: window.localStorage, authorizedDomains, baseUrl: apiBaseUrl });
}