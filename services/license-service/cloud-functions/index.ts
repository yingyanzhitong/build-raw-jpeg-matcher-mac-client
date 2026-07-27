import { handleLicenseRequest } from "./_handler";

export default function onRequest(context: Parameters<typeof handleLicenseRequest>[0]) {
  return handleLicenseRequest(context);
}
