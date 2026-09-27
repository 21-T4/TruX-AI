# Step 1: Use an official lightweight base image
FROM node:20-alpine AS builder

# Step 2: Set the working directory inside the container
WORKDIR /app

# Step 3: Copy dependency definitions first to leverage Docker cache
COPY package*.json ./

# Step 4: Install dependencies
RUN npm ci --only=production

# Step 5: Copy the rest of your application code
COPY . .

# Step 6: Google Cloud Run / App Engine default port is 8080
EXPOSE 8080

# Step 7: Define the environment variable for the port
ENV PORT=8080

# Step 8: Run the web service on container startup
CMD [ "npm", "start" ]
