"use strict";

console.log('Loading Lambda health check function');

var AWS = require('aws-sdk');
var Promise = require('bluebird');
var tcpp = require('tcp-ping');

const tableName = 'lambda-healthcheck';
const tagName = 'tcp_healthcheck';
const maxMissed = 3;
const DbReadCapacity = 10;
const DbWriteCapacity = 1;
var testContext = {invokedFunctionArn: 'arn:aws:lambda:us-east-1:651377294797:function:TcpHealthCheck'};
var vpcId;


/**
 * The handler for the Lambda function, primary function that gets called with each execution
 */
exports.handler = function handler (event, context, callback){
    console.log('Starting lambda healthcheck');

    var functionArn = context.invokedFunctionArn;
    var region = functionArn.split(':')[3];
    AWS.config.update({region: region});

    var lambda = new AWS.Lambda();

    lambda.getFunction({FunctionName: functionArn}).promise()
    .then(function(data){return getLambdaVpcId(data)}) // get the VPC id
    .then(function(){return createTable(tableName, DbReadCapacity, DbWriteCapacity)}) // create the table in DynamoDB if does not exsist
    .then(function(){return getInstances(tagName)}) // pull all the instances by tag that need to be health checked and perform checks
    .then(function(){return purgeDbEntries()})
    .catch(
                function (error){
                console.log('Error in Lambda Health Check \n'+error);
                }
    );

    callback(null, 'success');
};


/**
 * Retrieve a DynamoDB table to store tcp ping results, create it if does not exist
 */
function getLambdaVpcId(lambdaFunction){
    vpcId = lambdaFunction.Configuration.VpcConfig.VpcId;
    return Promise.fulfilled();
}


/**
 * Retrieve a DynamoDB table to store tcp ping results, create it if does not exist
 */
function createTable(tableName, readCapacity, writeCapacity) {

    readCapacity = (typeof readCapacity === 'undefined') ? 4 : readCapacity;
    writeCapacity = (typeof writeCapacity === 'undefined') ? 1 : writeCapacity;

    var dynamodb = new AWS.DynamoDB();

    return  dynamodb.listTables().promise() // get a list of tables
        .then(function(data){ // filter by tableName

            const exists = data.TableNames
                    .filter(function(name){
                        return name === tableName;
                    }).length > 0;
            if (exists) { // if it exists returns
                return Promise.resolve();
            }
            else { // else create a new table with single attribute for hash key, other values will be added as JSON
                var params = {
                    TableName: tableName,
                    AttributeDefinitions: [
                        {AttributeName: 'ec2-id', AttributeType: 'S'},
                        {AttributeName: 'vpc-id', AttributeType: 'S'},
                        {AttributeName: 'last_seen', AttributeType: 'N'}
                    ],
                    KeySchema: [{AttributeName: 'ec2-id', KeyType: 'HASH'}],
                    ProvisionedThroughput: {
                        ReadCapacityUnits: readCapacity,
                        WriteCapacityUnits: writeCapacity
                    },
                    GlobalSecondaryIndexes: [
                        {
                            IndexName: 'timestamp',
                            KeySchema: [
                                {AttributeName: 'vpc-id', KeyType: 'HASH'},
                                {AttributeName: 'last_seen', KeyType: 'RANGE'}],
                            Projection: {
                              ProjectionType: 'ALL'
                            },
                            ProvisionedThroughput: {
                                ReadCapacityUnits: 1,
                                WriteCapacityUnits: 1
                            }
                        }
                    ]
                };
                console.log('Creating table '+ tableName);
                return dynamodb.createTable(params).promise(); // returns a promise to create table
            }
        }).catch(
                function (error){
                console.log('Error creating DynamoDB table\n'+error);
                }
        );
}


/**
 * Gets all EC2 instances in VPC that have the tagName defined in constants
 */
function getInstances(tagName) {

    var ec2 = new AWS.EC2();

    ec2.describeInstances( // return instances that match tag filter
        {
            Filters: [
                {
                    Name: 'vpc-id',
                    Values: [vpcId]
                },
                {
                    Name: 'instance-state-name',
                    Values: ['running'] //only check instances that are in a running state
                },
                {
                    Name: 'tag:' + tagName,
                    Values: ['*']
                }]
        }
    ).promise()
        .then(function(data){ // then step through instances and call healthcheck on each instance
            for (let i = 0; i < data.Reservations.length; i++) {
                let reservation = data.Reservations[i];
                for (let j = 0; j < reservation.Instances.length; j++){
                    let instance = reservation.Instances[j];
                    console.log('Checking ' + instance['InstanceId']);
                    checkInstance(instance);
                }
            }
        }).catch(
                function (error){
                console.log('Error getting instances\n'+error);
                }
        );
}


/**
 * Pings instance and if it fails increments count and sets instance to unhealthy in autoscaling group if constant
 * maxMissed exceeded
 */
function checkInstance(instance){
    var port = instance.Tags.find(function(tag){return tag.Key==='tcp_healthcheck'}); // port is set to value in tag
    console.log('Attempting to ping instance ' + instance.InstanceId + ' at ' + instance.PrivateIpAddress +':'+ port.Value);
    var pingThenable = Promise.promisify(tcpp.ping); // promisfy the tcp-ping ping function

    pingThenable(
        {
            address: instance.PrivateIpAddress,
            port: port.Value,
            attempts: 1,
            timeaouts: 5000
        }
    ).then( // insert results into dynamodb
        function(data){return putInstanceIntoDB(instance, data)}
    ).then( // set EC2 unhealthy
        function(missedCount){return setInstanceHealth(instance, missedCount)}
    ).catch(
                function (error){
                console.log('Error checking instance\n'+error);
                }
    );
}


/**
 * Looks up instance in DynamoDB and adds if not present otherwise increments missed count
 */
function putInstanceIntoDB(instance, results){

    return new Promise(function (fulfill, reject) {
        //TODO: Remove any old db instance entries

        var instance_id = {  //query parameters to find instance in dynamodb
                TableName: tableName,
                Key: {'ec2-id': instance.InstanceId}
            };

        var docClient = new AWS.DynamoDB.DocumentClient();

        docClient.get(instance_id).promise() // get instance from db
            .then(function(data){ // THEN
                var missedCount = 0;
                var pingReturned = (results.min != undefined); // true if ping returned

                if (data.Item != undefined) { // IF there is already an entry
                    missedCount = pingReturned ? 0 : data.Item.missed_count + 1; // IF ping returned set to 0 ELSE increment missed count by 1
                    let update_instance = {
                        TableName: tableName,
                        Key: {'ec2-id': instance.InstanceId},
                        UpdateExpression: "set missed_count=:m, last_seen=:l",
                        ExpressionAttributeValues: {
                            ":m": missedCount,
                            ":l": Date.now()
                        },
                        ReturnValues: "UPDATED_NEW"
                    };
                    if (missedCount != data.Item.missed_count) // only update if missed count changed
                        docClient.update(update_instance).promise(); // set promise to db UPDATE action

                } else if (!pingReturned) { // ELSE if no entry AND ping did not return add one with failed count of one
                    missedCount = 1;
                    console.log('Adding ID to table: ' + instance.InstanceId);
                    let add_instance = {
                        TableName: tableName,
                        Item: {
                            'ec2-id': instance.InstanceId,
                            'vpc-id': vpcId,
                            'missed_count': missedCount,
                            'last_seen': Date.now()
                        }
                    };
                    docClient.put(add_instance).promise(); // set promise to db PUT action
                }
                fulfill(missedCount); // return the missed count in the promise
            })
            .catch(
                function (error){
                    console.log('Error adding instance to database \n'+error);
                }
        );
    })
}


/**
 * Sets the health state in the autoscaling group
 */
function setInstanceHealth(instance, missedCount) {

    var autoscaling = new AWS.AutoScaling();

    // if missed count is greater that the max then the instance is unhealthy
    var healthStatus = (missedCount > maxMissed) ? 'Unhealthy' : 'Healthy';

    var params = {
        InstanceId: instance.InstanceId,
        HealthStatus: healthStatus,
        ShouldRespectGracePeriod: true
    };
    console.log(instance.InstanceId + ' is ' + healthStatus + ' with a missed count of ' + missedCount);
    if (heathStatus == 'Unhealthy') {
        autoscaling.setInstanceHealth(params).promise().catch(function (error) {
            console.log('Error setting instance health, may not be part of an autoscaling group \n' + error)
        }); // request a promise for error handling
    }
}

function purgeDbEntries(){

    var weekAgo = new Date();
    //Date.now(); // create an variable with the date a week ago
    weekAgo.setDate(weekAgo.getDate() - 0);

    var queryParams = {
      TableName: tableName,
      IndexName: "timestamp",
      KeyConditionExpression: "#vid = :hkey AND #ls < :rkey",
      ExpressionAttributeNames:{
          "#vid": "vpc-id",
          "#ls": "last_seen"
      },
      ExpressionAttributeValues: {
        ":hkey": vpcId,
        ":rkey": weekAgo.getTime()
      }
    };

    var docClient = new AWS.DynamoDB.DocumentClient();

    docClient.query(queryParams).promise()
    .then(function(results){

        for (let i = 0; i < results.Items.length; i++){
            let deleteParams = {
                TableName: tableName,
                Key: {
                    'ec2-id': results.Items[i]['ec2-id']
                }
            }
            docClient.delete(deleteParams);
        }

    })
    .catch(
        function(error){
            console.log('Error purging old entries from database.\n'+error);
        }
    );

    return Promise.fulfilled(); // return promise to top level

}


exports.handler(null, testContext, function(returned){console.log('Function returned '+returned)});